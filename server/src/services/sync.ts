// Durable, rate-limited queue for price / inventory / logistics pushes.
// Target has no bulk endpoints: one item per call (and one DC per inventory call).
// Tasks are coalesced per item: the value is computed when the task runs, so rapid
// Shopify changes collapse into a single, current update.
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getShopify, getSync } from '../lib/settings.js';
import * as T from '../target/api.js';
import { computePrice, priceIssues } from './builder.js';

export type TaskKind = 'price' | 'inventory' | 'logistics';

export async function enqueue(kind: TaskKind, variantId: string, opts: { force?: boolean } = {}) {
  const dedupKey = `${kind}:${variantId}`;
  // pending task: run it now. running task: flag a re-run so a change that arrives mid-push isn't lost.
  await db.insert(schema.syncTasks).values({ kind, variantId, dedupKey, result: opts.force ? { force: true } : null })
    .onConflictDoUpdate({
      target: schema.syncTasks.dedupKey,
      set: {
        runAfter: sql`CASE WHEN ${schema.syncTasks.status} = 'pending' THEN now() ELSE ${schema.syncTasks.runAfter} END`,
        rerun: sql`${schema.syncTasks.status} = 'running'`,
        ...(opts.force ? { result: { force: true } } : {}),
      },
    });
}

export async function enqueueMany(kind: TaskKind, variantIds: string[], opts: { force?: boolean } = {}) {
  for (const id of variantIds) await enqueue(kind, id, opts);
  return variantIds.length;
}

/**
 * Units sold on Target that Shopify's stock does not know about yet: open/shipped lines of orders that were
 * neither created in Shopify nor deducted from Shopify stock. (Normally 0: new orders are pushed to Shopify
 * or deducted from Shopify stock as soon as they arrive. This covers the gap if that step failed.)
 */
let reservedCache: { at: number; map: Map<string, number> } | null = null;
/** Keyed by Target SKU (external_id) AND by TCIN, so items listed by the old app ("#shop-…" SKUs) match too. */
export async function reservedBySku(): Promise<Map<string, number>> {
  if (reservedCache && Date.now() - reservedCache.at < 5000) return reservedCache.map;
  const sync = await getSync();
  const recent = await db.select().from(schema.orders).where(and(
    inArray(schema.orders.status, ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED', 'SHIPPED']),
    sql`${schema.orders.orderDate} > now() - interval '30 days'`,
    sync.ordersCutoverAt ? sql`${schema.orders.orderDate} >= ${sync.ordersCutoverAt}` : sql`true`,
  ));
  const out = new Map<string, number>();
  const { deductShopifyStock, pushOrdersToShopify } = sync;
  // Can Target sales reach Shopify at all? On stage (writes off) Shopify never hears about them, so shipped units
  // must stay deducted here, or Target would get the old stock back after a shipment.
  const shop = await getShopify();
  const { getActiveEnv } = await import('../lib/settings.js');
  const shopifyUpdated = !!(shop.shopDomain && shop.accessToken) && ((await getActiveEnv()) === 'production' || sync.stage.allowShopifyWrites);
  // when the hub deducts Shopify stock itself, shipped units stay reserved until that deduction happened;
  // otherwise only still-open units are held back (your team updates Shopify stock for shipped units)
  const counted = !shopifyUpdated || (deductShopifyStock && !pushOrdersToShopify) ? ['PENDING', 'ACKNOWLEDGED_BY_SELLER', 'SHIPPED'] : ['PENDING', 'ACKNOWLEDGED_BY_SELLER'];
  for (const o of recent) {
    if (o.shopifyOrderId) continue;
    const adjusted = (o.shopifyStockAdjusted ?? {}) as Record<string, number>;
    for (const line of (o.raw as any)?.order_lines ?? []) {
      const sold = (line.order_line_statuses ?? []).filter((s: any) => counted.includes(s.status)).reduce((a: number, s: any) => a + Number(s.quantity || 0), 0);
      const missing = sold - (adjusted[line.external_id] ?? 0);
      if (missing <= 0) continue;
      if (line.external_id) out.set(line.external_id, (out.get(line.external_id) ?? 0) + missing);
      if (line.tcin) out.set(`tcin:${line.tcin}`, (out.get(`tcin:${line.tcin}`) ?? 0) + missing);
    }
  }
  reservedCache = { at: Date.now(), map: out };
  return out;
}

/** Desired quantity per Target distribution center for one variant. */
export async function desiredQuantities(v: typeof schema.variants.$inferSelect): Promise<Record<string, number>> {
  const sync = await getSync();
  const shop = await getShopify();
  let dcs = await db.select().from(schema.distributionCenters);
  if (!dcs.length) {
    // first stock push: load the seller's distribution centers from Target automatically
    const { syncSetupData } = await import('./taxonomy.js');
    await syncSetupData().catch((e: any) => { throw new Error(`Could not load your distribution centers from Target: ${e?.message ?? e}`); });
    dcs = await db.select().from(schema.distributionCenters);
    if (!dcs.length) throw new Error('Target returned no distribution centers for this seller. Ask Target to set one up on your account.');
  }
  const known = new Set(dcs.map((d) => d.id));
  // fixed stock set by hand in the hub (e.g. for Target's test orders): used instead of Shopify until cleared
  const fixed = (v.overrides as any)?.fixed_qty as Record<string, number> | undefined;
  const map = Object.fromEntries(Object.entries(shop.locationMap ?? {}).filter(([, dc]) => dc && known.has(dc)));
  const byLoc = (v.inventoryByLoc ?? {}) as Record<string, number>;
  const out: Record<string, number> = {};
  if (fixed && Object.keys(fixed).length) {
    for (const [dc, q] of Object.entries(fixed)) if (known.has(dc)) out[dc] = Math.max(0, Math.floor(Number(q) || 0));
  } else if (Object.keys(map).length) {
    for (const [loc, dc] of Object.entries(map)) if (dc) out[dc] = (out[dc] ?? 0) + Math.max(0, byLoc[loc] ?? 0);
    for (const [loc, q] of Object.entries(byLoc)) if (!loc.startsWith('gid://shopify/Location/')) out[dcs[0].id] = (out[dcs[0].id] ?? 0) + Math.max(0, q);
  }
  // no location mapping (or this SKU has no stock rows at mapped locations): all Shopify stock goes to the first DC
  if (!Object.keys(out).length && !(fixed && Object.keys(fixed).length)) out[dcs[0].id] = Math.max(0, v.inventory ?? 0);
  // stopped selling on Target (Price & inventory › Disable): 0 everywhere
  const vo = (v.overrides ?? {}) as any;
  if (vo._disabled) { for (const dc of Object.keys(out)) out[dc] = 0; if (!Object.keys(out).length) out[dcs[0].id] = 0; return out; }
  // buffer (safety stock): per SKU when set, otherwise the global one; then open-order reservation; largest DC first
  const buf = vo._buffer !== undefined && vo._buffer !== null && vo._buffer !== '' ? Math.max(0, Math.floor(Number(vo._buffer) || 0)) : sync.safetyStock;
  let deduct = buf;
  if (sync.reserveOpenOrders) {
    const res = await reservedBySku();
    deduct += (v.tcin ? res.get(`tcin:${v.tcin}`) : undefined) ?? (v.sku ? res.get(v.sku) : undefined) ?? 0;
  }
  for (const dc of Object.keys(out).sort((a, b) => out[b] - out[a])) {
    const take = Math.min(out[dc], deduct);
    out[dc] -= take; deduct -= take;
  }
  if (sync.maxQtyPerItem != null) for (const dc of Object.keys(out)) out[dc] = Math.min(out[dc], sync.maxQtyPerItem);
  return out;
}

async function runTask(task: typeof schema.syncTasks.$inferSelect) {
  const force = (task.result as any)?.force === true;
  const v = task.variantId ? await db.query.variants.findFirst({ where: eq(schema.variants.id, task.variantId) }) : null;
  if (!v) return { skipped: 'variant deleted' };
  if (!v.targetProductId) return { skipped: 'not on Target yet' };
  if (!v.syncEnabled) return { skipped: 'sync disabled for this variant' };

  if (task.kind === 'price') {
    const price = await computePrice(v);
    const problems = priceIssues(price);
    if (problems.length) throw new Error(problems.join('; '));
    if (!force && JSON.stringify(v.lastPriceSent) === JSON.stringify(price)) return { skipped: 'unchanged', price };
    // price guard: a big drop at once is held for approval (protects against a Shopify typo going live)
    const guard = Number((await getSync()).priceGuardPct ?? 40);
    const eff = (p: any) => (p ? Number(p.offer_price ?? p.list_price) : 0);
    const before = eff(v.lastPriceSent), after = eff(price);
    const key = JSON.stringify(price);
    if (guard > 0 && before > 0 && after < before * (1 - guard / 100) && (v.overrides as any)?._price_ok !== key) {
      const dropPct = Math.round((1 - after / before) * 1000) / 10;
      const ex = await db.execute(sql`SELECT id, status FROM price_holds WHERE variant_id = ${v.id} AND status IN ('held','rejected') AND proposed = ${key}::jsonb LIMIT 1`);
      if ((ex.rows[0] as any)?.status === 'rejected') return { skipped: 'price drop rejected by you; Target keeps the current price', price };
      if (!ex.rows.length) {
        await db.execute(sql`UPDATE price_holds SET status = 'replaced' WHERE variant_id = ${v.id} AND status = 'held'`);
        await db.execute(sql`INSERT INTO price_holds (variant_id, sku, current, proposed, drop_pct) VALUES (${v.id}, ${v.sku}, ${JSON.stringify(v.lastPriceSent)}::jsonb, ${key}::jsonb, ${dropPct})`);
        const { raise } = await import('./alerts.js');
        await raise({ kind: 'price-hold', severity: 'warning', ref: v.id, title: `Price drop held: ${v.sku} $${before.toFixed(2)} → $${after.toFixed(2)} (−${dropPct}%)`, detail: 'Not sent to Target. Approve or reject it on Price & inventory.', link: '/inventory' });
      }
      return { held: true, dropPct, price };
    }
    const res = await T.setPrice(v.targetProductId, price!);
    await db.update(schema.variants).set({ lastPriceSent: price, lastPriceSentAt: new Date() }).where(eq(schema.variants.id, v.id));
    return { sent: price, res };
  }
  if (task.kind === 'inventory') {
    const want = await desiredQuantities(v);
    const last = (v.lastQtySent ?? {}) as Record<string, number>;
    const sent: Record<string, number> = {};
    for (const [dc, q] of Object.entries(want)) {
      if (!force && last[dc] === q) continue;
      await T.setQuantity(v.targetProductId, dc, q);
      sent[dc] = q;
      await db.update(schema.variants).set({ lastQtySent: { ...last, ...sent }, lastQtySentAt: new Date() }).where(eq(schema.variants.id, v.id));
    }
    return Object.keys(sent).length ? { sent } : { skipped: 'unchanged', want };
  }
  if (task.kind === 'logistics') {
    const { pushLogistics } = await import('./items.js');
    return { res: await pushLogistics(v.id) };
  }
  throw new Error(`Unknown task kind ${task.kind}`);
}

let running = false;
let stopFlag = false;

/** Claim and run the next due task. Returns false when the queue is empty. */
export async function processNext(): Promise<boolean> {
  const claimed = await db.execute(sql`
    UPDATE sync_tasks SET status = 'running', attempts = attempts + 1, updated_at = now()
    WHERE id = (SELECT id FROM sync_tasks WHERE status = 'pending' AND run_after <= now() ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  const row: any = claimed.rows?.[0];
  if (!row) return false;
  const task = {
    id: row.id, kind: row.kind, variantId: row.variant_id, productId: row.product_id, dedupKey: row.dedup_key, status: row.status,
    attempts: row.attempts, lastError: row.last_error, result: row.result, runAfter: row.run_after, createdAt: row.created_at, updatedAt: row.updated_at,
    rerun: row.rerun,
  };
  try {
    const result = await runTask(task);
    // a change arrived while we were running: go again with the fresh value
    const again = await db.update(schema.syncTasks).set({ status: 'pending', rerun: false, attempts: 0, runAfter: new Date() })
      .where(and(eq(schema.syncTasks.id, task.id), eq(schema.syncTasks.rerun, true))).returning({ id: schema.syncTasks.id });
    // otherwise free the dedup key so the next change can enqueue a fresh task
    if (!again.length) await db.update(schema.syncTasks).set({ status: 'done', result, lastError: null, dedupKey: null }).where(eq(schema.syncTasks.id, task.id));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const permanent = e?.status && e.status >= 400 && e.status < 500 && e.status !== 429;
    if (task.attempts >= 5 || permanent) {
      await db.update(schema.syncTasks).set({ status: 'failed', lastError: msg, dedupKey: null, result: e?.body ?? null }).where(eq(schema.syncTasks.id, task.id));
    } else {
      await db.update(schema.syncTasks).set({ status: 'pending', lastError: msg, runAfter: new Date(Date.now() + 30_000 * 2 ** task.attempts) }).where(eq(schema.syncTasks.id, task.id));
    }
  }
  return true;
}

export function startWorker() {
  if (running) return;
  running = true;
  (async () => {
    // release tasks left "running" by a previous crash
    await db.update(schema.syncTasks).set({ status: 'pending' }).where(eq(schema.syncTasks.status, 'running'));
    while (!stopFlag) {
      let worked = false;
      try { worked = await processNext(); } catch (e) { console.error('sync worker', e); }
      if (!worked) await new Promise((r) => setTimeout(r, 2000));
    }
    running = false;
  })();
}
export function stopWorker() { stopFlag = true; }

export async function queueStats() {
  const r = await db.execute(sql`SELECT kind, status, count(*)::int AS n FROM sync_tasks WHERE status IN ('pending','running') OR updated_at > now() - interval '24 hours' GROUP BY kind, status`);
  return r.rows;
}

/** All variants that are live on Target. */
export async function targetVariantIds() {
  const rows = await db.select({ id: schema.variants.id }).from(schema.variants).where(and(isNotNull(schema.variants.targetProductId), eq(schema.variants.syncEnabled, true)));
  return rows.map((r) => r.id);
}

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
export async function reservedBySku(): Promise<Map<string, number>> {
  const recent = await db.select().from(schema.orders).where(and(
    inArray(schema.orders.status, ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED', 'SHIPPED']),
    sql`${schema.orders.orderDate} > now() - interval '30 days'`,
  ));
  const out = new Map<string, number>();
  const { deductShopifyStock, pushOrdersToShopify } = await getSync();
  // when the hub deducts Shopify stock itself, shipped units stay reserved until that deduction happened;
  // otherwise only still-open units are held back (your team updates Shopify stock for shipped units)
  const counted = deductShopifyStock && !pushOrdersToShopify ? ['PENDING', 'ACKNOWLEDGED_BY_SELLER', 'SHIPPED'] : ['PENDING', 'ACKNOWLEDGED_BY_SELLER'];
  for (const o of recent) {
    if (o.shopifyOrderId) continue;
    const adjusted = (o.shopifyStockAdjusted ?? {}) as Record<string, number>;
    for (const line of (o.raw as any)?.order_lines ?? []) {
      const sold = (line.order_line_statuses ?? []).filter((s: any) => counted.includes(s.status)).reduce((a: number, s: any) => a + Number(s.quantity || 0), 0);
      const missing = sold - (adjusted[line.external_id] ?? 0);
      if (missing > 0 && line.external_id) out.set(line.external_id, (out.get(line.external_id) ?? 0) + missing);
    }
  }
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
  if (fixed && Object.keys(fixed).length) {
    return Object.fromEntries(Object.entries(fixed).filter(([dc]) => known.has(dc)).map(([dc, q]) => [dc, Math.max(0, Math.floor(Number(q) || 0))]));
  }
  const map = Object.fromEntries(Object.entries(shop.locationMap ?? {}).filter(([, dc]) => dc && known.has(dc)));
  const byLoc = (v.inventoryByLoc ?? {}) as Record<string, number>;
  const out: Record<string, number> = {};
  if (Object.keys(map).length) {
    for (const [loc, dc] of Object.entries(map)) if (dc) out[dc] = (out[dc] ?? 0) + Math.max(0, byLoc[loc] ?? 0);
    for (const [loc, q] of Object.entries(byLoc)) if (!loc.startsWith('gid://shopify/Location/')) out[dcs[0].id] = (out[dcs[0].id] ?? 0) + Math.max(0, q);
  }
  // no location mapping (or this SKU has no stock rows at mapped locations): all Shopify stock goes to the first DC
  if (!Object.keys(out).length) out[dcs[0].id] = Math.max(0, v.inventory ?? 0);
  // safety stock + open-order reservation are taken from the largest DC first
  let deduct = sync.safetyStock;
  if (sync.reserveOpenOrders && v.sku) deduct += (await reservedBySku()).get(v.sku) ?? 0;
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

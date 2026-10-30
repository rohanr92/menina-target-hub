// Create / update / unlist items on Target and track their status.
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSync, getTargetCreds } from '../lib/settings.js';
import * as T from '../target/api.js';
import { buildProduct } from './builder.js';
import { enqueue } from './sync.js';

function latestStatus(prod: any) {
  const st: any[] = prod?.product_statuses ?? [];
  return st.find((s) => s.latest) ?? st.find((s) => s.current) ?? st.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
}

/** Target puts the TCIN in different places depending on the endpoint. */
const tcinOf = (prod: any): string | undefined => {
  const t = prod?.tcin ?? prod?.TCIN ?? prod?.item?.tcin ?? prod?.product?.tcin ?? latestStatus(prod)?.tcin;
  return t ? String(t) : undefined;
};

async function saveVariantFromTarget(variantId: string, prod: any) {
  const s = latestStatus(prod);
  await db.update(schema.variants).set({
    targetProductId: prod.id ?? undefined,
    tcin: tcinOf(prod),
    listingStatus: s?.listing_status ?? undefined,
    validationStatus: s?.validation_status ?? undefined,
    errors: s?.errors ?? [],
    statusCheckedAt: new Date(),
  }).where(eq(schema.variants.id, variantId));
}

async function saveParentFromTarget(productId: string, prod: any) {
  const s = latestStatus(prod);
  await db.update(schema.products).set({
    targetParentId: prod.id ?? undefined,
    targetParentTcin: tcinOf(prod),
    parentStatus: s?.listing_status ?? undefined,
    parentValidation: s?.validation_status ?? undefined,
    parentErrors: s?.errors ?? [],
  }).where(eq(schema.products.id, productId));
}

export interface PushOptions { allowWarnings?: boolean; force?: boolean; onlyNew?: boolean; onlyVariantIds?: string[] }

/** Send switch per SKU: explicit on/off, otherwise OFF for items unlisted on Target (an update would list them again). */
export function sendEnabled(v: { overrides: any; listingStatus: string | null }) {
  const s = (v.overrides as any)?._send;
  if (s === true || s === false) return s;
  return v.listingStatus !== 'UNLISTED';
}

/**
 * Send a product to Target.
 * - SA: POST /products (new) or PUT /products/{id} (existing, full field list)
 * - Variations: POST product_variation_update with parent + new children; existing children are PUT individually
 *   (Target FAQ #8: updating through the family endpoint can push approved items back to PENDING).
 */
export async function pushProduct(productId: string, opts: PushOptions = {}) {
  const p0 = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  const ovk = (p0?.overrides as any) ?? {};
  const locked = [true, 'true'].includes(ovk._keep_target_content ?? ovk.keep_target_content);
  const built0 = await buildProduct(productId);
  // which items go out: the chosen SKUs, with the Send switch on; for existing (locked) items only when the
  // hub already holds Target's own data for them, so nothing from Shopify replaces what is on Target
  const vsAll = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const vById = new Map(vsAll.map((v) => [v.id, v]));
  const skipped: any[] = [];
  const items = built0.items.filter((it) => {
    const v = it.variantId ? vById.get(it.variantId) : undefined;
    if (!v) return true;
    if (opts.onlyVariantIds?.length && !opts.onlyVariantIds.includes(v.id)) return false;
    if (v.targetProductId && !sendEnabled(v)) { skipped.push({ sku: it.sku, action: 'skipped', reason: v.listingStatus === 'UNLISTED' ? 'unlisted on Target (Send is off)' : 'Send is off' }); return false; }
    if (locked && v.targetProductId && !(v.overrides as any)?._from_target) { skipped.push({ sku: it.sku, action: 'skipped', reason: 'Target data not copied into the hub yet (Target catalog › 4)' }); return false; }
    return true;
  });
  if (built0.items.length && !items.length) return { ok: !!skipped.length, results: skipped, issues: built0.issues, nothingToSend: true, error: skipped.length ? undefined : 'Nothing to send' };
  const parentLocked = locked && !!p0?.targetParentId && !(p0?.overrides as any)?._from_target;
  const built = { ...built0, items, issues: built0.issues.filter((i: any) => !i.scope || items.some((it) => i.scope.includes(it.sku)) || !built0.items.some((it) => i.scope.includes(it.sku))) };
  const errors = built.issues.filter((i) => i.level === 'error');
  if (errors.length && !opts.force) {
    return { ok: false, blocked: true, issues: built.issues };
  }
  const p = (await db.query.products.findFirst({ where: eq(schema.products.id, productId) }))!;
  const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const byId = new Map(vs.map((v) => [v.id, v]));
  const results: any[] = [...skipped];
  try {
    if (!built.parent) {
      for (const it of built.items) {
        const v = byId.get(it.variantId!)!;
        if (v.targetProductId) {
          if (opts.onlyNew) continue;
          const r = await T.updateProduct(v.targetProductId, it.payload);
          await saveVariantFromTarget(v.id, { ...r, id: r?.id ?? v.targetProductId });
          results.push({ sku: it.sku, action: 'updated', id: v.targetProductId });
        } else {
          let r: any;
          try {
            r = await T.createProduct(it.payload);
          } catch (e: any) {
            // timeout / 5xx: Target may have created it anyway. Look it up by SKU before giving up.
            const found = e?.ambiguous ? (await T.getCatalog({ external_id: it.sku }).catch(() => []))[0] : null;
            if (!found) throw e;
            r = found;
          }
          await saveVariantFromTarget(v.id, r);
          results.push({ sku: it.sku, action: 'created', id: r?.id, tcin: r?.tcin });
        }
      }
    } else {
      const newChildren = built.items.filter((it) => !byId.get(it.variantId!)?.targetProductId);
      const existingChildren = built.items.filter((it) => byId.get(it.variantId!)?.targetProductId);
      if (!p.targetParentId || newChildren.length) {
        let res: any;
        try {
          res = await T.createOrUpdateVariationFamily({ parent: built.parent, children: newChildren.map((c) => c.payload) });
        } catch (e: any) {
          if (!e?.ambiguous) throw e;
          // unclear outcome: rebuild the result list from the catalog
          const ext = [built.parent.external_id, ...newChildren.map((c) => c.sku)];
          const found = (await Promise.all(ext.map((x) => T.getCatalog({ external_id: x }).then((l) => l[0]).catch(() => null)))).filter(Boolean);
          if (!found.length) throw e;
          res = { results: found.map((f: any) => ({ external_id: f.external_id, status: 201, product: f })) };
        }
        if (!Array.isArray(res?.results)) throw new Error(`Unexpected response from product_variation_update: ${JSON.stringify(res).slice(0, 300)}`);
        for (const r of res.results) {
          const ok = !r.status || (r.status >= 200 && r.status < 300);
          if (r.external_id === built.parent.external_id) {
            if (r.product) await saveParentFromTarget(productId, r.product);
            results.push({ sku: r.external_id, action: ok ? 'parent saved' : 'parent failed', reason: r.reason, id: r.product?.id, tcin: r.product?.tcin });
          } else {
            const it = newChildren.find((c) => c.sku === r.external_id);
            if (it && r.product) await saveVariantFromTarget(it.variantId!, r.product);
            results.push({ sku: r.external_id, action: ok ? 'created' : 'failed', reason: r.reason, id: r.product?.id, tcin: r.product?.tcin });
          }
        }
        await db.update(schema.products).set({ parentExternalId: built.parent.external_id }).where(eq(schema.products.id, productId));
      } else if (!opts.onlyNew && p.targetParentId && !parentLocked) {
        const r = await T.updateProduct(p.targetParentId, built.parent);
        await saveParentFromTarget(productId, { ...r, id: r?.id ?? p.targetParentId });
        results.push({ sku: built.parent.external_id, action: 'parent updated' });
      }
      if (!opts.onlyNew) {
        for (const it of existingChildren) {
          const v = byId.get(it.variantId!)!;
          const r = await T.updateProduct(v.targetProductId!, it.payload);
          await saveVariantFromTarget(v.id, { ...r, id: r?.id ?? v.targetProductId });
          results.push({ sku: it.sku, action: 'updated', id: v.targetProductId });
        }
      }
    }
    // every item we sent must now have a Target id; otherwise report the push as failed
    const fresh = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
    const sentIds = new Set(built.items.map((i) => i.variantId));
    const missing = fresh.filter((v) => sentIds.has(v.id) && !v.targetProductId).map((v) => v.sku);
    const failedRows = results.filter((r) => /failed/.test(r.action));
    const parentMissing = built.parent && !(await db.query.products.findFirst({ where: eq(schema.products.id, productId) }))?.targetParentId;
    const problem = [
      parentMissing ? 'parent was not created' : '',
      failedRows.length ? `${failedRows.length} item(s) failed: ${failedRows.map((r) => `${r.sku} (${r.reason ?? 'no reason'})`).join(', ')}` : '',
      missing.length ? `no Target id returned for ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    await db.update(schema.products).set({ lastPushedAt: new Date(), lastPushError: problem || null }).where(eq(schema.products.id, productId));
    // price + inventory (+ logistics) must be sent after creation
    const sync = await getSync();
    const creds = await getTargetCreds();
    const hasPolicy = !!((p.logistics as any)?.seller_return_policy || sync.defaultLogistics.seller_return_policy || creds.returnPolicy);
    for (const v of fresh.filter((x) => x.targetProductId && sentIds.has(x.id))) {
      await enqueue('price', v.id); await enqueue('inventory', v.id);
      if (hasPolicy && results.some((r) => r.sku === v.sku && r.action === 'created')) await enqueue('logistics', v.id);
    }
    return problem ? { ok: false, error: problem, results, issues: built.issues } : { ok: true, results, issues: built.issues };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await db.update(schema.products).set({ lastPushError: msg }).where(eq(schema.products.id, productId));
    return { ok: false, error: msg, details: e?.body, results, issues: built.issues };
  }
}

/** Refresh listing/validation status for one product's items from Target. */
export async function refreshProductStatus(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) throw new Error('Product not found');
  if (p.targetParentId) await saveParentFromTarget(productId, await T.getProduct(p.targetParentId));
  const vs = await db.select().from(schema.variants).where(and(eq(schema.variants.productId, productId), isNotNull(schema.variants.targetProductId)));
  for (const v of vs) await saveVariantFromTarget(v.id, await T.getProduct(v.targetProductId!));
  const tcins = await fillMissingTcins(productId);
  return { refreshed: vs.length + (p.targetParentId ? 1 : 0), tcinsFound: tcins };
}

/**
 * TCINs are assigned a little after creation and the single-item endpoint does not always return them.
 * Look them up in the catalog by SKU (external_id) for items that still have none.
 */
export async function fillMissingTcins(productId?: string) {
  let found = 0;
  const vs = await db.select().from(schema.variants).where(and(isNotNull(schema.variants.targetProductId), isNull(schema.variants.tcin), ...(productId ? [eq(schema.variants.productId, productId)] : [])));
  for (const v of vs.slice(0, 100)) {
    if (!v.sku) continue;
    const c = (await T.getCatalog({ external_id: v.sku }).catch(() => [])).find((x: any) => x.external_id === v.sku || x.id === v.targetProductId);
    const t = tcinOf(c);
    if (t) { await db.update(schema.variants).set({ tcin: t }).where(eq(schema.variants.id, v.id)); found++; }
  }
  const ps = await db.select().from(schema.products).where(and(isNotNull(schema.products.targetParentId), isNull(schema.products.targetParentTcin), ...(productId ? [eq(schema.products.id, productId)] : [])));
  for (const p of ps) {
    if (!p.parentExternalId) continue;
    const c = (await T.getCatalog({ external_id: p.parentExternalId }).catch(() => [])).find((x: any) => x.external_id === p.parentExternalId || x.id === p.targetParentId);
    const t = tcinOf(c);
    if (t) { await db.update(schema.products).set({ targetParentTcin: t }).where(eq(schema.products.id, p.id)); found++; }
  }
  return found;
}

/** Refresh every item using the paginated catalog endpoint (few calls). Also links items created elsewhere by SKU. */
export async function refreshAllStatuses() {
  const catalog = await T.getCatalog({ expand: 'product_statuses' });
  const byExt = new Map(catalog.map((c: any) => [c.external_id, c]));
  const byId = new Map(catalog.map((c: any) => [c.id, c]));
  const vs = await db.select().from(schema.variants);
  let updated = 0;
  for (const v of vs) {
    const c: any = (v.targetProductId && byId.get(v.targetProductId)) || (v.sku ? byExt.get(v.sku) : null);
    if (c && c.relationship_type !== 'VAP') { await saveVariantFromTarget(v.id, c); updated++; }
  }
  const ps = await db.select().from(schema.products).where(or(isNotNull(schema.products.parentExternalId), isNotNull(schema.products.targetParentId)));
  for (const p of ps) {
    const c: any = (p.targetParentId && byId.get(p.targetParentId)) || (p.parentExternalId ? byExt.get(p.parentExternalId) : null);
    if (c) { await saveParentFromTarget(p.id, c); updated++; }
  }
  return { catalogItems: catalog.length, updated };
}

/** Refresh only items still waiting on review. */
export async function refreshPending() {
  const vs = await db.select().from(schema.variants).where(and(isNotNull(schema.variants.targetProductId),
    or(inArray(schema.variants.listingStatus, ['PENDING']), inArray(schema.variants.validationStatus, ['INITIATED', 'REVIEW']))));
  for (const v of vs.slice(0, 200)) await saveVariantFromTarget(v.id, await T.getProduct(v.targetProductId!));
  await fillMissingTcins().catch(() => 0);
  return vs.length;
}

export async function unlistVariant(variantId: string) {
  const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) });
  if (!v?.targetProductId) throw new Error('Item is not on Target yet');
  // the LIVE version decides: an item can show "Rejected" (its latest update was rejected) while an older approved
  // version is still selling. That live version can be unlisted. An item that was never approved is not on sale.
  const prod = await T.getProduct(v.targetProductId);
  const sts: any[] = prod?.product_statuses ?? [];
  const live = sts.find((x) => x.current && x.listing_status === 'APPROVED') ?? sts.find((x) => x.listing_status === 'APPROVED');
  if (sts.some((x) => x.current && x.listing_status === 'UNLISTED')) { await saveVariantFromTarget(v.id, prod); throw new Error('Already unlisted on Target'); }
  if (!live) { await saveVariantFromTarget(v.id, prod); throw new Error(`Not live on Target (${latestStatus(prod)?.listing_status ?? v.listingStatus ?? 'unknown'}, never approved), so there is nothing to unlist. Turn Send OFF so it is not sent again.`); }
  const r = live.current ? await T.unlistProduct(v.targetProductId) : await T.unlistByStatus(v.targetProductId, live.id);
  await saveVariantFromTarget(v.id, { ...r, id: v.targetProductId });
  return r;
}

export async function logisticsFields(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  const sync = await getSync();
  const creds = await getTargetCreds();
  const l = { ...sync.defaultLogistics, ...(p?.logistics ?? {}) };
  if (!l.seller_return_policy) l.seller_return_policy = creds.returnPolicy ?? '';
  if (!l.seller_return_policy) throw new Error('Return policy ID is missing. Add it in Settings › Target (Return policy ID); all 4 logistics fields must be sent together.');
  return [
    { name: 'fulfillment.is_add_on', value: l.is_add_on || 'No' },
    { name: 'fulfillment.two_day_shipping_eligible', value: l.two_day_shipping_eligible || 'No' },
    { name: 'shipping_exclusion', value: l.shipping_exclusion || 'No' },
    { name: 'seller_return_policy', value: l.seller_return_policy },
  ];
}

/** Logistics must include all 4 fields each time; never sent for parents (VAP). */
export async function pushLogistics(variantId: string) {
  const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) });
  if (!v?.targetProductId) throw new Error('Item is not on Target yet');
  const fields = await logisticsFields(v.productId);
  return T.setLogistics(v.targetProductId, fields);
}

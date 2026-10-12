// Target catalog: pull everything already on Target, match it to Shopify variants by UPC (then SKU),
// link the matches, and import missing Shopify products by UPC — like Marketplace Hub's auto-UPC mode.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getActiveEnv } from '../lib/settings.js';
import * as T from '../target/api.js';
import { importByCodes } from './catalog.js';

const field = (fields: any[], name: string) => fields?.find((f) => f.name === name)?.value ?? null;
/** UPC-A 012345678905 and EAN-13 0012345678905 are the same code. */
export const normBarcode = (b?: string | null) => (b ? b.replace(/\D/g, '').replace(/^0+/, '') : '');

function latest(p: any) {
  const st: any[] = p.product_statuses ?? [];
  return st.find((s) => s.latest) ?? st.find((s) => s.current) ?? st[st.length - 1] ?? {};
}

export async function storeTargetProduct(p: any, env?: string) {
  const fields = p.fields ?? [];
  const st = latest(p);
  const row = {
    id: String(p.id), env: env ?? (await getActiveEnv()), tcin: p.tcin ?? null, externalId: p.external_id ?? null, relationshipType: p.relationship_type ?? null,
    parentId: p.parent_id ?? null, barcode: field(fields, 'barcode.value'),
    title: field(fields, 'descriptions.title') ?? field(fields, 'descriptions.parent_title'),
    itemTypeName: field(fields, 'item_type.name'), listingStatus: st.listing_status ?? null, validationStatus: st.validation_status ?? null,
    fields, fetchedAt: new Date(),
  };
  await db.insert(schema.targetItems).values(row).onConflictDoUpdate({ target: schema.targetItems.id, set: { ...row, matchedVariantId: undefined, matchedProductId: undefined, matchBy: undefined } });
  return row;
}

/** Download the whole Target catalog (with fields) into target_items, then match. */
export async function syncTargetCatalog() {
  const env = await getActiveEnv();
  const items = await T.getCatalog({ expand: 'fields,product_statuses' });
  const seen = new Set<string>();
  for (const p of items) {
    const row = await storeTargetProduct(p, env);
    seen.add(row.id);
  }
  // drop items no longer returned for this environment
  const old = await db.select({ id: schema.targetItems.id }).from(schema.targetItems).where(eq(schema.targetItems.env, env));
  const gone = old.map((o) => o.id).filter((id) => !seen.has(id));
  if (gone.length) await db.delete(schema.targetItems).where(inArray(schema.targetItems.id, gone));
  const match = await matchTargetItems();
  return { fetched: items.length, ...match };
}

/** Match Target items to hub variants: UPC first, SKU second. Parents match through their children. */
export async function matchTargetItems() {
  const env = await getActiveEnv();
  const tItems = await db.select().from(schema.targetItems).where(eq(schema.targetItems.env, env));
  const vs = await db.select({ id: schema.variants.id, productId: schema.variants.productId, sku: schema.variants.sku, barcode: schema.variants.barcode }).from(schema.variants);
  const byBarcode = new Map<string, typeof vs[number]>();
  const bySku = new Map<string, typeof vs[number]>();
  for (const v of vs) {
    if (v.barcode) byBarcode.set(normBarcode(v.barcode), v);
    if (v.sku) bySku.set(v.sku.trim().toLowerCase(), v);
  }
  let upc = 0, sku = 0, parents = 0, unmatched = 0;
  for (const t of tItems.filter((x) => x.relationshipType !== 'VAP')) {
    let v = t.barcode ? byBarcode.get(normBarcode(t.barcode)) : undefined;
    let by: string | null = v ? 'upc' : null;
    if (!v && t.externalId) { v = bySku.get(t.externalId.trim().toLowerCase()); if (v) by = 'sku'; }
    if (by === 'upc') upc++; else if (by === 'sku') sku++; else unmatched++;
    await db.update(schema.targetItems).set({ matchedVariantId: v?.id ?? null, matchedProductId: v?.productId ?? null, matchBy: by }).where(eq(schema.targetItems.id, t.id));
  }
  // parents: product of any matched child
  const fresh = await db.select().from(schema.targetItems).where(eq(schema.targetItems.env, env));
  for (const parent of fresh.filter((x) => x.relationshipType === 'VAP')) {
    const child = fresh.find((c) => c.parentId === parent.id && c.matchedProductId);
    if (child) parents++;
    await db.update(schema.targetItems).set({ matchedProductId: child?.matchedProductId ?? null, matchBy: child ? 'parent' : null }).where(eq(schema.targetItems.id, parent.id));
  }
  return { matchedByUpc: upc, matchedBySku: sku, unmatched, parentsMatched: parents };
}

/**
 * Link matched Target items to hub products, so the hub updates them (price, inventory, content)
 * instead of creating duplicates. Only fills variants that are not linked yet.
 */
export async function linkMatches(opts: { ids?: string[] } = {}) {
  const env = await getActiveEnv();
  const conds = [eq(schema.targetItems.env, env), sql`${schema.targetItems.matchedProductId} IS NOT NULL`];
  if (opts.ids?.length) conds.push(inArray(schema.targetItems.id, opts.ids));
  const rows = await db.select().from(schema.targetItems).where(and(...conds));
  const types = await db.select().from(schema.itemTypes);
  let linked = 0, skipped = 0;
  for (const t of rows) {
    if (t.relationshipType === 'VAP') {
      const p = await db.query.products.findFirst({ where: eq(schema.products.id, t.matchedProductId!) });
      if (p && !p.targetParentId) {
        await db.update(schema.products).set({ targetParentId: t.id, targetParentTcin: t.tcin, parentExternalId: t.externalId, parentStatus: t.listingStatus, parentValidation: t.validationStatus }).where(eq(schema.products.id, p.id));
        linked++;
      } else skipped++;
      continue;
    }
    if (!t.matchedVariantId) continue;
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, t.matchedVariantId) });
    if (!v || (v.targetProductId && v.targetProductId !== t.id)) { skipped++; continue; }
    await db.update(schema.variants).set({ targetProductId: t.id, tcin: t.tcin, listingStatus: t.listingStatus, validationStatus: t.validationStatus, statusCheckedAt: new Date() }).where(eq(schema.variants.id, v.id));
    // adopt Target's item type for the product when it has none yet
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, v.productId) });
    if (p && !p.itemTypeId && t.itemTypeName) {
      const it = types.find((x) => x.name.toLowerCase() === t.itemTypeName!.toLowerCase());
      if (it) await db.update(schema.products).set({ itemTypeId: it.id }).where(eq(schema.products.id, p.id));
    }
    linked++;
  }
  return { linked, skipped };
}

/** For Target items with no Shopify match: find their UPCs/SKUs in Shopify, import those products, re-match. */
export async function importUnmatchedFromShopify() {
  const env = await getActiveEnv();
  const rows = await db.select().from(schema.targetItems).where(and(eq(schema.targetItems.env, env), isNull(schema.targetItems.matchedVariantId), sql`${schema.targetItems.relationshipType} IS DISTINCT FROM 'VAP'`));
  const codes = [...new Set(rows.flatMap((r) => [r.barcode, r.externalId]).filter(Boolean) as string[])];
  if (!codes.length) return { searched: 0, products: 0, notFound: [] as string[] };
  const r = await importByCodes(codes);
  const m = await matchTargetItems();
  return { ...r, ...m };
}

/** Field values Target currently has for a product id (from the last catalog fetch). */
export async function targetFieldsFor(productId: string | null | undefined) {
  if (!productId) return null;
  const t = await db.query.targetItems.findFirst({ where: eq(schema.targetItems.id, productId) });
  return t ? { fields: t.fields, fetchedAt: t.fetchedAt } : null;
}

/** Fetch what Target currently holds for one hub product (parent + items), for the side-by-side view. */
export async function fetchTargetForProduct(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const ids = [p?.targetParentId, ...vs.map((v) => v.targetProductId)].filter(Boolean) as string[];
  for (const id of ids) {
    const t = await T.getProduct(id);
    await storeTargetProduct(t);
    await db.update(schema.targetItems).set({ matchedProductId: productId, matchedVariantId: vs.find((v) => v.targetProductId === id)?.id ?? null, matchBy: 'linked' }).where(eq(schema.targetItems.id, id));
  }
  return { fetched: ids.length };
}

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
/** Marks a product as "keep the content already on Target": Send / bulk send skip it (stock + orders still sync). */
async function lockContent(productId: string) {
  await db.execute(sql`UPDATE products SET overrides = overrides || '{"_keep_target_content": true}'::jsonb WHERE id = ${productId} AND NOT (overrides ? '_keep_target_content') AND NOT (overrides ? 'keep_target_content')`);
}

/**
 * Existing Target items: copy every field Target has into the hub as overrides, so the hub shows (and would send)
 * Target's data instead of building it from Shopify. Done once per item; later hub edits are kept.
 * VC/SA fields go on the variant, VAP (parent) fields on the product.
 */
async function adoptTargetFields(t: typeof schema.targetItems.$inferSelect) {
  const fields = (t.fields ?? []) as { name: string; value: any }[];
  if (!fields.length) return false;
  const vals: Record<string, any> = {};
  for (const f of fields) if (f?.name && f.value !== undefined && f.value !== null && f.value !== '') vals[f.name] = Array.isArray(f.value) ? f.value.join('|') : String(f.value);
  if (t.relationshipType === 'VAP') {
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, t.matchedProductId!) });
    if (!p || (p.overrides as any)?._from_target) return false;
    await db.update(schema.products).set({ overrides: { ...(p.overrides as any), ...vals, _from_target: t.id } }).where(eq(schema.products.id, p.id));
    return true;
  }
  if (!t.matchedVariantId) return false;
  const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, t.matchedVariantId) });
  if (!v || (v.overrides as any)?._from_target) return false;
  await db.update(schema.variants).set({ overrides: { ...(v.overrides as any), ...vals, _from_target: t.id } }).where(eq(schema.variants.id, v.id));
  return true;
}

export async function linkMatches(opts: { ids?: string[] } = {}) {
  const env = await getActiveEnv();
  const conds = [eq(schema.targetItems.env, env), sql`${schema.targetItems.matchedProductId} IS NOT NULL`];
  if (opts.ids?.length) conds.push(inArray(schema.targetItems.id, opts.ids));
  const rows = await db.select().from(schema.targetItems).where(and(...conds));
  const types = await db.select().from(schema.itemTypes);
  let linked = 0, skipped = 0, adopted = 0;
  for (const t of rows) {
    // items that were already on Target keep Target's content: the hub never overwrites them by itself
    await lockContent(t.matchedProductId!);
    if (await adoptTargetFields(t)) adopted++;
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
  return { linked, skipped, adopted };
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

/** Progress of "Copy Target data into the hub" (runs in the background, ~2 items / second). */
export const adoptProgress = { running: false, total: 0, done: 0, copied: 0, fetched: 0, failed: 0, startedAt: null as Date | null, finishedAt: null as Date | null, lastError: null as string | null };

/**
 * For every linked existing item: make sure we have Target's full field list (the catalog list often has no
 * fields, so each item is read on its own), then copy those values into the hub (once per item).
 */
export async function adoptAllTargetData(opts: { force?: boolean } = {}) {
  if (adoptProgress.running) return adoptProgress;
  const env = await getActiveEnv();
  const rows = await db.select().from(schema.targetItems).where(and(eq(schema.targetItems.env, env), sql`${schema.targetItems.matchedProductId} IS NOT NULL`));
  Object.assign(adoptProgress, { running: true, total: rows.length, done: 0, copied: 0, fetched: 0, failed: 0, startedAt: new Date(), finishedAt: null, lastError: null });
  (async () => {
    for (const t0 of rows) {
      try {
        let t = t0;
        if (opts.force) {
          // forget the earlier copy so Target's current data is copied again
          if (t.relationshipType === 'VAP') await db.execute(sql`UPDATE products SET overrides = overrides - '_from_target' WHERE id = ${t.matchedProductId}`);
          else if (t.matchedVariantId) await db.execute(sql`UPDATE variants SET overrides = overrides - '_from_target' WHERE id = ${t.matchedVariantId}`);
        }
        if (!((t.fields ?? []) as any[]).length || opts.force) {
          await new Promise((r) => setTimeout(r, 400)); // stay well under Target's rate limit
          const fresh = await T.getProduct(t.id);
          await storeTargetProduct(fresh, env);
          t = (await db.query.targetItems.findFirst({ where: eq(schema.targetItems.id, t.id) })) ?? t;
          adoptProgress.fetched++;
        }
        if (await adoptTargetFields(t)) adoptProgress.copied++;
      } catch (e: any) {
        adoptProgress.failed++; adoptProgress.lastError = `${t0.externalId ?? t0.id}: ${e?.message ?? e}`;
      }
      adoptProgress.done++;
    }
    adoptProgress.running = false; adoptProgress.finishedAt = new Date();
  })().catch((e) => { adoptProgress.running = false; adoptProgress.lastError = String(e?.message ?? e); });
  return adoptProgress;
}

/**
 * Existing products with no item type in the hub: take the category the items already have on Target,
 * add that category to the hub (with its fields and allowed values) and set it on the product.
 */
export async function autoItemTypesFromTarget() {
  const env = await getActiveEnv();
  const { saveItemTypes, syncAttributes, syncValues } = await import('./taxonomy.js');
  const prods = await db.select().from(schema.products).where(isNull(schema.products.itemTypeId));
  const types = await db.select().from(schema.itemTypes);
  const byName = new Map(types.map((t) => [t.name.toLowerCase(), t.id]));
  const out: { product: string; itemType?: string; error?: string }[] = [];
  const added: string[] = [];
  for (const p of prods) {
    const items = await db.select().from(schema.targetItems).where(and(eq(schema.targetItems.env, env), eq(schema.targetItems.matchedProductId, p.id)));
    const votes = new Map<string, number>();
    for (const t of items) if (t.itemTypeName) votes.set(t.itemTypeName, (votes.get(t.itemTypeName) ?? 0) + 1);
    const name = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!name) { out.push({ product: p.title, error: items.length ? 'Target has no category on these items' : 'not linked to Target items' }); continue; }
    let id = byName.get(name.toLowerCase());
    try {
      if (!id) {
        // the item itself carries its category id; fall back to searching the taxonomy by name
        const one = items.find((t) => t.relationshipType !== 'VAP') ?? items[0];
        const prod = await T.getProduct(one.id).catch(() => null);
        id = prod?.item_type_id ? String(prod.item_type_id) : undefined;
        if (!id) {
          const hits = await T.searchItemTypes(name);
          const exact = hits.find((h: any) => String(h.name ?? '').toLowerCase() === name.toLowerCase());
          id = exact ? String(exact.id) : undefined;
        }
        if (!id) { out.push({ product: p.title, error: `category "${name}" not found in Target's list` }); continue; }
        await saveItemTypes([{ id, name }]);
        byName.set(name.toLowerCase(), id);
        added.push(name);
        try {
          await syncAttributes(id);
          // value lists take many calls: load them in the background
          const itId = id;
          syncValues(itId).catch(() => null);
        } catch (e: any) {
          out.push({ product: `${name} (category)`, error: `added, but its fields could not be loaded yet: ${e?.message ?? e}. Open Taxonomy & mapping › ${name} › Pull attributes.` });
        }
      }
      await db.update(schema.products).set({ itemTypeId: id }).where(eq(schema.products.id, p.id));
      out.push({ product: p.title, itemType: name });
    } catch (e: any) {
      out.push({ product: p.title, error: e?.message ?? String(e) });
    }
  }
  return { products: prods.length, set: out.filter((x) => x.itemType).length, addedCategories: [...new Set(added)], problems: out.filter((x) => x.error) };
}

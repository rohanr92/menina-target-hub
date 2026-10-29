// Import products from Shopify (or Marketplace Hub / file) into the hub catalog.
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting, getShopify, HubSettings } from '../lib/settings.js';
import { availableAt, PRODUCTS_BY_IDS, PRODUCTS_QUERY, shopifyGraphql, VARIANT_STOCK_QUERY, VARIANTS_BY_CODE, weightToLb } from '../shopify/client.js';
import { bulletsFromHtml } from './text.js';

export interface SourceVariant {
  sourceId: string; inventoryItemId?: string | null; sku?: string | null; barcode?: string | null; title?: string | null;
  price?: string | number | null; compareAtPrice?: string | number | null; options: Record<string, string>;
  weightLb?: number | null; imageUrl?: string | null; inventoryByLoc: Record<string, number>;
}
export interface SourceProduct {
  source: 'shopify' | 'hub' | 'file'; sourceId: string; handle?: string | null; title: string; descriptionHtml?: string | null;
  vendor?: string | null; productType?: string | null; tags: string[]; images: string[]; optionNames: string[];
  status?: string | null; variants: SourceVariant[];
}

function mapShopifyProduct(p: any): SourceProduct {
  const images: string[] = (p.media?.nodes ?? []).map((m: any) => m?.image?.url).filter(Boolean);
  return {
    source: 'shopify', sourceId: p.id, handle: p.handle, title: p.title, descriptionHtml: p.descriptionHtml,
    vendor: p.vendor, productType: p.productType, tags: p.tags ?? [], images,
    optionNames: (p.options ?? []).map((o: any) => o.name).filter((n: string) => n && n !== 'Title'),
    status: p.status,
    variants: (p.variants?.nodes ?? []).map((v: any) => ({
      sourceId: v.id, inventoryItemId: v.inventoryItem?.id, sku: v.sku, barcode: v.barcode, title: v.title,
      price: v.price, compareAtPrice: v.compareAtPrice,
      options: Object.fromEntries((v.selectedOptions ?? []).filter((o: any) => o.name !== 'Title').map((o: any) => [o.name, o.value])),
      weightLb: weightToLb(v.inventoryItem?.measurement?.weight),
      imageUrl: v.media?.nodes?.[0]?.image?.url ?? null,
      inventoryByLoc: availableAt(v.inventoryItem?.inventoryLevels),
    })),
  };
}

export async function totalForMappedLocations(byLoc: Record<string, number>): Promise<number> {
  const s = await getShopify();
  const map = s.locationMap ?? {};
  const mapped = Object.keys(map);
  const entries = Object.entries(byLoc).filter(([loc]) => !mapped.length || mapped.includes(loc) || !loc.startsWith('gid://shopify/Location/'));
  return entries.reduce((sum, [, q]) => sum + Math.max(0, q), 0);
}

export async function upsertSourceProduct(sp: SourceProduct) {
  const existing = await db.query.products.findFirst({ where: eq(schema.products.sourceId, sp.sourceId) });
  const base = {
    source: sp.source, sourceId: sp.sourceId, handle: sp.handle ?? null, title: sp.title, descriptionHtml: sp.descriptionHtml ?? null,
    vendor: sp.vendor ?? null, productType: sp.productType ?? null, tags: sp.tags, images: sp.images, optionNames: sp.optionNames,
    shopifyStatus: sp.status ?? null,
  };
  let productId: string;
  if (existing) {
    await db.update(schema.products).set(base).where(eq(schema.products.id, existing.id));
    productId = existing.id;
  } else {
    const [row] = await db.insert(schema.products).values({ ...base, bullets: bulletsFromHtml(sp.descriptionHtml) }).returning({ id: schema.products.id });
    productId = row.id;
  }
  const changedVariantIds: string[] = [];
  for (const v of sp.variants) {
    const inventory = await totalForMappedLocations(v.inventoryByLoc);
    const vals = {
      productId, sourceId: v.sourceId, inventoryItemId: v.inventoryItemId ?? null, sku: v.sku ?? null, barcode: v.barcode ?? null,
      title: v.title ?? null, price: v.price != null && v.price !== '' ? String(v.price) : null,
      compareAtPrice: v.compareAtPrice != null && v.compareAtPrice !== '' ? String(v.compareAtPrice) : null,
      options: v.options, weightLb: v.weightLb ?? null, imageUrl: v.imageUrl ?? null, inventoryByLoc: v.inventoryByLoc, inventory,
    };
    const ev = await db.query.variants.findFirst({ where: eq(schema.variants.sourceId, v.sourceId) });
    if (ev) {
      if (ev.inventory !== inventory || String(ev.price) !== String(vals.price) || String(ev.compareAtPrice) !== String(vals.compareAtPrice)) changedVariantIds.push(ev.id);
      await db.update(schema.variants).set(vals).where(eq(schema.variants.id, ev.id));
    } else {
      await db.insert(schema.variants).values(vals);
    }
  }
  // Remove variants deleted at the source (only when never sent to Target)
  const keep = new Set(sp.variants.map((v) => v.sourceId));
  const current = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const stale = current.filter((v) => !keep.has(v.sourceId) && !v.targetProductId).map((v) => v.id);
  if (stale.length) await db.delete(schema.variants).where(inArray(schema.variants.id, stale));
  return { productId, created: !existing, changedVariantIds };
}

/** Import (or refresh) Shopify products. query uses Shopify search syntax, e.g. "status:active vendor:'Menina Step'". */
export async function importFromShopify(opts: { query?: string; limit?: number } = {}) {
  const s = await getShopify();
  const query = opts.query ?? s.importQuery ?? 'status:active';
  let after: string | null = null;
  let count = 0, created = 0;
  const changed: string[] = [];
  for (;;) {
    const data: any = await shopifyGraphql(PRODUCTS_QUERY, { first: 10, after, query: query || null }, 'shopify-import');
    for (const p of data.products.nodes) {
      const r = await upsertSourceProduct(mapShopifyProduct(p));
      count++; if (r.created) created++;
      changed.push(...r.changedVariantIds);
      if (opts.limit && count >= opts.limit) return { count, created, changedVariantIds: changed };
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return { count, created, changedVariantIds: changed };
}

/** Refresh stock + price for the given variants straight from Shopify. Returns variant ids whose values changed. */
export async function refreshVariantsFromShopify(variantRows: { id: string; sourceId: string; inventory: number; price: string | null; compareAtPrice: string | null }[]) {
  const changed: string[] = [];
  for (let i = 0; i < variantRows.length; i += 100) {
    const chunk = variantRows.slice(i, i + 100).filter((v) => v.sourceId.startsWith('gid://shopify/ProductVariant/'));
    if (!chunk.length) continue;
    const data: any = await shopifyGraphql(VARIANT_STOCK_QUERY, { ids: chunk.map((v) => v.sourceId) }, 'shopify-stock');
    for (const node of data.nodes ?? []) {
      if (!node?.id) continue;
      const row = chunk.find((v) => v.sourceId === node.id)!;
      const byLoc = availableAt(node.inventoryItem?.inventoryLevels);
      const inventory = await totalForMappedLocations(byLoc);
      const price = node.price != null ? String(node.price) : null;
      const compareAtPrice = node.compareAtPrice != null ? String(node.compareAtPrice) : null;
      if (inventory !== row.inventory || Number(price) !== Number(row.price) || Number(compareAtPrice ?? 0) !== Number(row.compareAtPrice ?? 0)) changed.push(row.id);
      await db.update(schema.variants).set({ inventory, inventoryByLoc: byLoc, price, compareAtPrice }).where(eq(schema.variants.id, row.id));
    }
  }
  return changed;
}

/**
 * Marketplace Hub import. Expects GET {url} -> JSON array of products:
 * [{ id, handle, title, descriptionHtml, vendor, productType, tags[], images[], options[],
 *    variants: [{ id, sku, barcode, title, price, compareAtPrice, options{}, weightLb, imageUrl, inventory }] }]
 */
export async function importFromHub() {
  const hub = await getSetting<HubSettings>('hub', {});
  if (!hub.url) throw new Error('Marketplace Hub export URL is not set (Settings > Marketplace Hub).');
  const res = await fetch(hub.url, { headers: hub.token ? { authorization: `Bearer ${hub.token}` } : {} });
  if (!res.ok) throw new Error(`Marketplace Hub returned ${res.status}`);
  const json: any = await res.json();
  const list: any[] = Array.isArray(json) ? json : json.products ?? json.data ?? [];
  return importGenericProducts(list, 'hub');
}

export async function importGenericProducts(list: any[], source: 'hub' | 'file') {
  let count = 0;
  for (const p of list) {
    const pid = String(p.id ?? p.sourceId ?? p.handle ?? p.title);
    const sp: SourceProduct = {
      source, sourceId: p.id?.toString().startsWith('gid://') ? p.id : `${source}:${pid}`, handle: p.handle ?? null, title: p.title,
      descriptionHtml: p.descriptionHtml ?? p.description ?? p.body_html ?? null, vendor: p.vendor ?? p.brand ?? null,
      productType: p.productType ?? p.product_type ?? null, tags: p.tags ?? [], images: p.images ?? [],
      optionNames: p.options ?? p.optionNames ?? [], status: p.status ?? null,
      variants: (p.variants ?? []).map((v: any) => ({
        sourceId: v.id?.toString().startsWith('gid://') ? v.id : `${source}:${pid}:${v.sku ?? v.id}`,
        sku: v.sku, barcode: v.barcode ?? v.upc ?? null, title: v.title ?? null, price: v.price ?? null,
        compareAtPrice: v.compareAtPrice ?? v.compare_at_price ?? null, options: v.options ?? {},
        weightLb: v.weightLb ?? null, imageUrl: v.imageUrl ?? null,
        inventoryByLoc: v.inventoryByLoc ?? { default: Number(v.inventory ?? v.quantity ?? 0) },
      })),
    };
    if (!sp.title || !sp.variants.length) continue;
    await upsertSourceProduct(sp);
    count++;
  }
  return { count };
}

/**
 * Import the Shopify products that contain the given UPCs / EANs (or SKUs).
 * Accepts any mix; each code is searched as barcode and as SKU. Returns what was found and what wasn't.
 */
export async function importByCodes(rawCodes: string[]) {
  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  const productIds = new Set<string>();
  const found = new Set<string>();
  const q = (c: string) => JSON.stringify(c);
  for (let i = 0; i < codes.length; i += 20) {
    const chunk = codes.slice(i, i + 20);
    const query = chunk.map((c) => `barcode:${q(c)} OR sku:${q(c)}`).join(' OR ');
    let after: string | null = null;
    for (;;) {
      const d: any = await shopifyGraphql(VARIANTS_BY_CODE, { q: query, after }, 'shopify-import-codes');
      for (const v of d.productVariants.nodes) {
        const hit = chunk.find((c) => c === v.barcode || c === v.sku);
        if (!hit) continue; // Shopify search is fuzzy; keep exact matches only
        found.add(hit);
        productIds.add(v.product.id);
      }
      if (!d.productVariants.pageInfo.hasNextPage) break;
      after = d.productVariants.pageInfo.endCursor;
    }
  }
  const ids = [...productIds];
  let count = 0, created = 0;
  const changed: string[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const d: any = await shopifyGraphql(PRODUCTS_BY_IDS, { ids: ids.slice(i, i + 10) }, 'shopify-import-codes');
    for (const p of d.nodes ?? []) {
      if (!p?.id) continue;
      const r = await upsertSourceProduct(mapShopifyProduct(p));
      count++; if (r.created) created++;
      changed.push(...r.changedVariantIds);
    }
  }
  return { searched: codes.length, foundCodes: found.size, notFound: codes.filter((c) => !found.has(c)), products: count, created, changedVariantIds: changed };
}

/** Re-read one product (images, options, variants) from Shopify, e.g. after new photos were added there. */
export async function reloadProductFromShopify(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p || p.source !== 'shopify' || !p.sourceId.startsWith('gid://shopify/Product/')) return { reloaded: false };
  const d: any = await shopifyGraphql(PRODUCTS_BY_IDS, { ids: [p.sourceId] }, 'shopify-reload');
  const sp = (d.nodes ?? []).find((x: any) => x?.id);
  if (!sp) return { reloaded: false };
  await upsertSourceProduct(mapShopifyProduct(sp));
  return { reloaded: true, images: (sp.media?.nodes ?? []).length };
}

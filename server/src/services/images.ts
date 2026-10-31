import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as T from '../target/api.js';
import { detectOptions } from './builder.js';
import { reloadProductFromShopify } from './catalog.js';
import { storeTargetProduct } from './targetCatalog.js';
import { sendEnabled } from './items.js';

/**
 * Image plan per color, chosen by hand in the hub (drag & drop of the Shopify images):
 *   products.overrides._image_plan = { "<color value>": [url, url, ...], "_all": [...] }
 * The first image of a color is its primary image, the rest are its alternate images.
 * "Send images" changes ONLY the images on Target: every other field Target already has is sent back unchanged.
 */
export type ImagePlan = Record<string, string[]>;
const ALL = '_all';
const IMG_RE = /^digital_assets\.images\.(primary_image_url|alternate_image_urls|parent_image_url)/;
const MAX_ALT = 10;

const imagesOf = (fields: { name: string; value: any }[] | null | undefined) => {
  const f = fields ?? [];
  const val = (n: string) => f.find((x) => x.name === n)?.value;
  const alts = f.filter((x) => x.name.startsWith('digital_assets.images.alternate_image_urls'))
    .sort((a, b) => Number(a.name.match(/\[(\d+)\]/)?.[1] ?? 0) - Number(b.name.match(/\[(\d+)\]/)?.[1] ?? 0))
    .map((x) => String(x.value)).filter(Boolean);
  const primary = val('digital_assets.images.primary_image_url') ?? val('digital_assets.images.parent_image_url');
  return [primary, ...alts].filter(Boolean).map(String);
};

async function load(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const { colorOption } = detectOptions(p);
  const colorOf = (v: typeof vs[number]) => (colorOption ? String((v.options as any)?.[colorOption] ?? '') : '') || ALL;
  return { p, vs, colorOption, colorOf, plan: ((p.overrides as any)?._image_plan ?? {}) as ImagePlan };
}

/** Everything the image editor needs: Shopify image pool, colors, what Target shows now, saved plan. */
export async function imageEditor(productId: string) {
  // always show the latest Shopify photos (new ones added in Shopify appear right away)
  let reloadError: string | null = null;
  try { await reloadProductFromShopify(productId); } catch (e: any) { reloadError = e?.message ?? String(e); }
  const { p, vs, colorOption, colorOf, plan } = await load(productId);
  const pool = [...new Set([...(p.images as string[]), ...vs.map((v) => v.imageUrl).filter(Boolean) as string[]])];
  const groups = new Map<string, typeof vs>();
  for (const v of vs) { const c = colorOf(v); groups.set(c, [...(groups.get(c) ?? []), v]); }
  const colors: any[] = [];
  for (const [color, list] of groups) {
    const linked = list.find((v) => v.targetProductId);
    const t = linked ? await db.query.targetItems.findFirst({ where: eq(schema.targetItems.id, linked.targetProductId!) }) : null;
    // suggestion: the variant image first, then pool images whose file name mentions the color
    const word = color.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const varImg = list.map((v) => v.imageUrl).find(Boolean);
    const suggested = [...new Set([varImg, ...pool.filter((u) => color !== ALL && word && u.toLowerCase().includes(word))].filter(Boolean) as string[])];
    colors.push({
      color, skus: list.map((v) => v.sku), linkedCount: list.filter((v) => v.targetProductId).length, willGet: list.filter((v) => v.targetProductId && sendEnabled(v)).length, skippedSkus: list.filter((v) => v.targetProductId && !sendEnabled(v)).map((v) => `${v.sku}${v.listingStatus === 'UNLISTED' ? ' (unlisted)' : ' (Send OFF)'}`),
      onTarget: imagesOf(t?.fields as any), onTargetFetchedAt: t?.fetchedAt ?? null,
      plan: plan[color] ?? null, suggested: suggested.length ? suggested : pool.slice(0, 5),
    });
  }
  return { colorOption, pool, colors, hasParent: !!p.targetParentId, reloadError };
}

export async function saveImagePlan(productId: string, plan: ImagePlan) {
  const { p } = await load(productId);
  const clean: ImagePlan = {};
  for (const [k, list] of Object.entries(plan ?? {})) {
    const urls = [...new Set((list ?? []).map(String).filter((u) => /^https?:\/\//.test(u)))].slice(0, MAX_ALT + 1);
    if (urls.length) clean[k] = urls;
  }
  await db.update(schema.products).set({ overrides: { ...((p.overrides as any) ?? {}), _image_plan: clean } }).where(eq(schema.products.id, productId));
  return { saved: Object.keys(clean).length };
}

/** Replace only the image fields, keep every other field exactly as Target has it. */
function withImages(fields: { name: string; value: any }[], urls: string[], level: string) {
  const keep = fields.filter((f) => !IMG_RE.test(f.name));
  const img = level === 'VAP'
    ? [{ name: 'digital_assets.images.parent_image_url', value: urls[0] }]
    : [{ name: 'digital_assets.images.primary_image_url', value: urls[0] },
       ...urls.slice(1, MAX_ALT + 1).map((u, i) => ({ name: `digital_assets.images.alternate_image_urls[${i + 1}]`, value: u }))];
  return [...keep, ...img];
}

/** Send only the images of the saved plan to Target (works on locked "keep Target content" products). */
export async function pushImages(productId: string, opts: { colors?: string[] } = {}) {
  const { p, vs, colorOf, plan } = await load(productId);
  if (!Object.keys(plan).length) throw Object.assign(new Error('No images chosen yet. Arrange the images per color and save first.'), { statusCode: 400 });
  const results: any[] = [];
  const pick = (c: string) => plan[c] ?? plan[ALL];
  for (const v of vs) {
    if (!v.targetProductId) continue;
    // never touch sizes that are unlisted or switched to Send OFF: an update would list them again
    if (!sendEnabled(v)) { results.push({ sku: v.sku, color: colorOf(v), action: 'skipped', reason: v.listingStatus === 'UNLISTED' ? 'unlisted (kept unlisted)' : 'Send is OFF for this SKU' }); continue; }
    const color = colorOf(v);
    if (opts.colors?.length && !opts.colors.includes(color)) continue;
    const urls = pick(color);
    if (!urls?.length) { results.push({ sku: v.sku, color, action: 'skipped', reason: 'no images chosen for this color' }); continue; }
    try {
      const cur = await T.getProduct(v.targetProductId); // fresh copy: never send stale fields back
      // never touch items you unlisted: any update creates a new version, which could list the size again
      const st = (cur.product_statuses ?? []).find((x: any) => x.latest) ?? (cur.product_statuses ?? []).find((x: any) => x.current);
      const cs = (cur.product_statuses ?? []).find((x: any) => x.current);
      if ([st?.listing_status, cs?.listing_status].includes('UNLISTED') || v.listingStatus === 'UNLISTED') {
        results.push({ sku: v.sku, color, action: 'skipped', reason: 'unlisted on Target (kept unlisted)' }); continue;
      }
      const fields = withImages(cur.fields ?? [], urls, cur.relationship_type ?? 'VC');
      const r = await T.updateProduct(v.targetProductId, { external_id: cur.external_id, relationship_type: cur.relationship_type, fields });
      await storeTargetProduct({ ...cur, ...r, id: r?.id ?? v.targetProductId, fields });
      results.push({ sku: v.sku, color, action: 'images sent', count: urls.length });
    } catch (e: any) {
      results.push({ sku: v.sku, color, action: 'failed', reason: e?.message ?? String(e) });
    }
  }
  // parent: first color's first image (only when sending everything)
  if (p.targetParentId && !opts.colors?.length) {
    const first = Object.entries(plan).find(([, l]) => l.length)?.[1];
    if (first) {
      try {
        const cur = await T.getProduct(p.targetParentId);
        const fields = withImages(cur.fields ?? [], first, 'VAP');
        const r = await T.updateProduct(p.targetParentId, { external_id: cur.external_id, relationship_type: 'VAP', fields });
        await storeTargetProduct({ ...cur, ...r, id: r?.id ?? p.targetParentId, fields });
        results.push({ sku: cur.external_id, color: 'parent', action: 'images sent', count: 1 });
      } catch (e: any) {
        results.push({ sku: 'parent', color: 'parent', action: 'failed', reason: e?.message ?? String(e) });
      }
    }
  }
  const failed = results.filter((r) => r.action === 'failed');
  return { ok: !failed.length, sent: results.filter((r) => r.action === 'images sent').length, failed: failed.length, results };
}

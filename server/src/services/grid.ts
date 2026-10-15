// Bulk mapping grid: one row per SKU, one column per Target attribute of the item type.
// Edit cells one by one or for many SKUs at once, auto-map from Shopify data, and
// download / upload the same thing as an Excel sheet with dropdowns.
import ExcelJS from 'exceljs';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Attribute, Product, Variant } from '../db/schema.js';
import { NONE, attrKey, buildProduct, detectOptions, detectTheme, loadTaxo, matchAllowed } from './builder.js';
import { descriptionWithoutList, normalize, stripHtml } from './text.js';
import { parseCsv, syncAttributes, syncValues } from './taxonomy.js';
import { importAllowedItemTypes, refreshReport, requestReport } from './reports.js';

export type Section = 'listing' | 'variation' | 'required' | 'images' | 'bullets' | 'optional';
export interface GridColumn {
  key: string; name: string; type: string; section: Section; required: boolean; maxSelections: number;
  attrId: string | null; values: string[] | null; valueCount: number; description: string | null;
}

const IMG_RE = /^digital_assets\.images?\./;
const BULLET_RE = /^descriptions\.bullets\[(\d+)\]$/;
const ALT_RE = /alternate_image_urls\[(\d+)\]$/;
const LOGISTICS_KEYS = new Set(['fulfillment.is_add_on', 'fulfillment.two_day_shipping_eligible', 'shipping_exclusion', 'seller_return_policy']);
const ITEM_TYPE_KEY = '__itemType';
const INLINE_VALUES = 500; // value lists up to this size travel with the columns; larger ones load on demand

/** Core Target fields (used when no item type is chosen, and added if the item type's list lacks them). */
const CORE: [string, string, string][] = [
  ['descriptions.title', 'Product Title', 'TEXT'], ['brands.name', 'Brand', 'TEXT'], ['descriptions.long_description', 'Description', 'TEXT'],
  ['barcode.value', 'Barcode', 'TEXT'], ['descriptions.parent_title', 'Parent Title', 'TEXT'],
  ['child_variations.color', 'Color (variation)', 'TEXT'], ['child_variations.size', 'Size (variation)', 'TEXT'],
  ['package_dimensions.measurements.depth', 'Package Depth (in)', 'MEASURE'], ['package_dimensions.measurements.width', 'Package Width (in)', 'MEASURE'],
  ['package_dimensions.measurements.height', 'Package Height (in)', 'MEASURE'], ['package_dimensions.measurements.weight', 'Package Weight (lb)', 'MEASURE'],
  ['digital_assets.images.primary_image_url', 'Main Image', 'TEXT'],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`digital_assets.images.alternate_image_urls[${n}]`, `Additional Image ${n}`, 'TEXT'] as [string, string, string]),
  ...[1, 2, 3, 4, 5].map((n) => [`descriptions.bullets[${n}]`, `Bullet Feature ${n}`, 'TEXT'] as [string, string, string]),
  ['compliance.import_designation', 'Import Designation', 'TEXT'], ['compliance.is_proposition_65', 'Prop 65', 'TEXT'],
  ['compliance.tax_category.tax_code', 'Tax Code', 'TEXT'],
];
const CORE_REQUIRED = new Set(['descriptions.title', 'brands.name', 'descriptions.long_description', 'barcode.value', 'digital_assets.images.primary_image_url',
  'package_dimensions.measurements.depth', 'package_dimensions.measurements.width', 'package_dimensions.measurements.height', 'package_dimensions.measurements.weight']);

function sectionFor(key: string, required: boolean): Section {
  if (key === 'descriptions.title' || key === 'brands.name' || key === 'descriptions.long_description') return 'listing';
  if (key.startsWith('child_variations.') || key === 'descriptions.parent_title' || key === 'variation.theme') return 'variation';
  if (IMG_RE.test(key)) return 'images';
  if (BULLET_RE.test(key)) return 'bullets';
  return required ? 'required' : 'optional';
}
const SECTION_ORDER: Section[] = ['listing', 'variation', 'required', 'images', 'bullets', 'optional'];
function numIn(key: string, re: RegExp) { const m = key.match(re); return m ? Number(m[1]) : 0; }

// ---------------------------------------------------------------- columns
export async function gridColumns(itemTypeId?: string | null): Promise<GridColumn[]> {
  const cols = new Map<string, GridColumn>();
  if (itemTypeId) {
    const taxo = await loadTaxo(itemTypeId);
    for (const a of taxo.attrs) {
      const key = attrKey(a);
      if (a.group === 'LOGISTICS' || LOGISTICS_KEYS.has(key) || key === 'item_type.name' || key === 'variation.theme') continue;
      const vals = taxo.values.get(a.id) ?? [];
      cols.set(key, {
        key, name: a.name, type: a.type, section: sectionFor(key, a.required), required: a.required, maxSelections: a.maxSelections,
        attrId: a.id, values: a.type === 'VALUE' && vals.length <= INLINE_VALUES ? [...vals].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) : null,
        valueCount: vals.length, description: a.description,
      });
    }
  }
  for (const [key, name, type] of CORE) {
    if (cols.has(key)) continue;
    // with an item type: only add core keys Target always uses (the rest come from the item type's own list)
    if (itemTypeId && (ALT_RE.test(key) || BULLET_RE.test(key)) && [...cols.keys()].some((k) => (ALT_RE.test(key) ? ALT_RE : BULLET_RE).test(k))) continue;
    const required = CORE_REQUIRED.has(key);
    cols.set(key, { key, name, type, section: sectionFor(key, required), required, maxSelections: 1, attrId: null, values: null, valueCount: 0, description: null });
  }
  return [...cols.values()].sort((a, b) => {
    const s = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (s) return s;
    if (a.section === 'images') return (a.key.includes('primary') ? -1 : 0) - (b.key.includes('primary') ? -1 : 0) || numIn(a.key, ALT_RE) - numIn(b.key, ALT_RE);
    if (a.section === 'bullets') return numIn(a.key, BULLET_RE) - numIn(b.key, BULLET_RE);
    if (a.section === 'listing') return ['descriptions.title', 'brands.name', 'descriptions.long_description'].indexOf(a.key) - ['descriptions.title', 'brands.name', 'descriptions.long_description'].indexOf(b.key);
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------- rows
export interface GridRow {
  variantId: string; productId: string; sku: string; productTitle: string; variantTitle: string; options: Record<string, string>;
  image: string | null; productImages: string[]; price: string | null; compareAtPrice: string | null; inventory: number;
  barcode: string | null; mockBarcode: string | null; itemTypeId: string | null; itemTypeName: string | null;
  theme: string; level: 'SA' | 'VC'; listingStatus: string | null; validationStatus: string | null; tcin: string | null; onTarget: boolean;
  syncEnabled: boolean; values: Record<string, string>; sources: Record<string, string>; sourceText: Record<string, string>; errors: string[]; warnings: number;
}

const ovText = (x: any) => (Array.isArray(x) ? x.join('|') : x === undefined || x === null ? undefined : String(x));
const readAuto = (a: any): string[] => (Array.isArray(a) ? a : typeof a === 'string' ? a.split('|').filter(Boolean) : []);
export const autoKeys = (p: Product): string[] => readAuto((p.overrides as any)?._auto);
const variantAutoKeys = (v: Variant): string[] => readAuto((v.overrides as any)?._auto);

/** Values shown when the product has no item type yet (no Target build possible). */
function basicValues(p: Product, v: Variant, theme: string): Record<string, string> {
  const { sizeOption, colorOption } = detectOptions(p);
  const color = colorOption ? (v.options as any)[colorOption] : undefined;
  const size = sizeOption ? (v.options as any)[sizeOption] : undefined;
  const imgs = [...new Set([v.imageUrl, ...(p.images as string[])].filter(Boolean) as string[])];
  const out: Record<string, string> = {
    'descriptions.title': theme === 'SA' ? p.title : [p.title, color, size].filter(Boolean).join(' - '),
    'brands.name': p.vendor ?? '',
    'descriptions.long_description': descriptionWithoutList(p.descriptionHtml) || stripHtml(p.descriptionHtml),
    'barcode.value': v.barcode ?? '',
    'digital_assets.images.primary_image_url': imgs[0] ?? '',
  };
  if (theme !== 'SA') out['descriptions.parent_title'] = p.title;
  if (color) out['child_variations.color'] = String(color);
  if (size) out['child_variations.size'] = String(size);
  imgs.slice(1, 9).forEach((u, i) => { out[`digital_assets.images.alternate_image_urls[${i + 1}]`] = u; });
  (p.bullets as string[]).forEach((b, i) => { out[`descriptions.bullets[${i + 1}]`] = b; });
  if (v.weightLb) out['package_dimensions.measurements.weight'] = v.weightLb.toFixed(2);
  out['compliance.import_designation'] = 'imported';
  out['compliance.is_proposition_65'] = 'No';
  out['compliance.tax_category.tax_code'] = /shoe|boot|sandal|sneaker|loafer|flat|heel|slipper|clog|mule|pump|oxford|mary jane/i.test(`${p.title} ${p.productType ?? ''}`) ? 'Shoes' : 'General Clothing';
  return out;
}

export async function buildRows(prods: Product[], vs: Variant[]): Promise<GridRow[]> {
  const types = await db.select({ id: schema.itemTypes.id, name: schema.itemTypes.name }).from(schema.itemTypes);
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const rows: GridRow[] = [];
  for (const p of prods) {
    const mine = vs.filter((v) => v.productId === p.id).sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));
    if (!mine.length) continue;
    const allVariants = await db.select().from(schema.variants).where(eq(schema.variants.productId, p.id));
    const theme = detectTheme(p, allVariants);
    let built: Awaited<ReturnType<typeof buildProduct>> | null = null;
    if (p.itemTypeId) { try { built = await buildProduct(p.id); } catch { built = null; } }
    const pAuto = autoKeys(p);
    for (const v of mine) {
      const vAuto = variantAutoKeys(v);
      const scope = v.sku ?? v.id;
      const values: Record<string, string> = {};
      const sourceText: Record<string, string> = {};
      const trace = built?.trace[scope];
      if (trace) {
        for (const t of trace) {
          if (t.key === 'item_type.name') continue;
          values[t.key] = values[t.key] ? `${values[t.key]}|${t.value}` : t.value;
          sourceText[t.key] = t.source + (t.original ? ` (from "${t.original}")` : '');
        }
      } else {
        Object.assign(values, basicValues(p, v, theme));
        for (const k of Object.keys(values)) sourceText[k] = 'From Shopify';
      }
      const sources: Record<string, string> = {};
      const keys = new Set([...Object.keys(values), ...Object.keys(v.overrides as any ?? {}), ...Object.keys(p.overrides as any ?? {})]);
      for (const k of keys) {
        if (k.startsWith('_')) continue;
        const vov = (v.overrides as any)?.[k], pov = (p.overrides as any)?.[k];
        const ov = vov ?? pov;
        if (ov === NONE) { sources[k] = 'none'; values[k] = ''; sourceText[k] = 'Left empty on purpose'; continue; }
        if (ov !== undefined && ov !== null && ov !== '') {
          sources[k] = (vov !== undefined ? vAuto.includes(k) : pAuto.includes(k)) ? 'auto' : vov !== undefined ? 'variant' : 'product';
          if (!trace) values[k] = ovText(ov) ?? '';
        } else if (values[k] !== undefined) sources[k] = 'shopify';
      }
      const myIssues = (built?.issues ?? []).filter((i) => i.scope === scope || i.scope === 'product');
      rows.push({
        variantId: v.id, productId: p.id, sku: v.sku ?? '', productTitle: p.title, variantTitle: v.title ?? '', options: v.options as any,
        image: v.imageUrl || (p.images as string[])[0] || null, productImages: [...new Set([v.imageUrl, ...(p.images as string[])].filter(Boolean) as string[])],
        price: v.price, compareAtPrice: v.compareAtPrice, inventory: v.inventory, barcode: v.barcode, mockBarcode: v.mockBarcode,
        itemTypeId: p.itemTypeId, itemTypeName: p.itemTypeId ? typeName.get(p.itemTypeId) ?? p.itemTypeId : null,
        theme, level: theme === 'SA' ? 'SA' : 'VC', listingStatus: v.listingStatus, validationStatus: v.validationStatus, tcin: v.tcin,
        onTarget: !!v.targetProductId, syncEnabled: v.syncEnabled, values, sources, sourceText,
        errors: myIssues.filter((i) => i.level === 'error').map((i) => i.message), warnings: myIssues.filter((i) => i.level === 'warning').length,
      });
    }
  }
  return rows;
}

export interface GridQuery { itemTypeId?: string; q?: string; productIds?: string[]; variantIds?: string[]; state?: string; page?: number; pageSize?: number }

async function findProducts(f: GridQuery) {
  const conds: any[] = [];
  if (f.itemTypeId === 'none') conds.push(isNull(schema.products.itemTypeId));
  else if (f.itemTypeId) conds.push(eq(schema.products.itemTypeId, f.itemTypeId));
  if (f.productIds?.length) conds.push(inArray(schema.products.id, f.productIds));
  if (f.variantIds?.length) conds.push(sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.id IN (${sql.join(f.variantIds.map((x) => sql`${x}`), sql`, `)}))`);
  if (f.q) conds.push(or(ilike(schema.products.title, `%${f.q}%`), sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND (v.sku ILIKE ${'%' + f.q + '%'} OR v.barcode ILIKE ${'%' + f.q + '%'} OR v.tcin = ${f.q}))`));
  if (f.state === 'on_target') conds.push(sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.target_product_id IS NOT NULL)`);
  if (f.state === 'not_on_target') conds.push(sql`NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.target_product_id IS NOT NULL)`);
  return conds.length ? and(...conds) : undefined;
}

export async function gridPage(f: GridQuery) {
  const where = await findProducts(f);
  const pageSize = Math.min(f.pageSize ?? 25, 200), page = Math.max(1, f.page ?? 1);
  const prods = await db.select().from(schema.products).where(where).orderBy(desc(schema.products.updatedAt), asc(schema.products.id)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.products).where(where);
  const ids = prods.map((p) => p.id);
  let vs = ids.length ? await db.select().from(schema.variants).where(inArray(schema.variants.productId, ids)) : [];
  if (f.variantIds?.length) vs = vs.filter((v) => f.variantIds!.includes(v.id));
  return { total: n, page, pageSize, rows: await buildRows(prods, vs) };
}

/** All rows matching a filter (or a list of variants), for sheet downloads and bulk actions. */
export async function allRows(f: GridQuery, max = 3000) {
  const where = await findProducts(f);
  const prods = await db.select().from(schema.products).where(where).orderBy(asc(schema.products.title)).limit(max);
  const ids = prods.map((p) => p.id);
  let vs = ids.length ? await db.select().from(schema.variants).where(inArray(schema.variants.productId, ids)) : [];
  if (f.variantIds?.length) vs = vs.filter((v) => f.variantIds!.includes(v.id));
  return buildRows(prods, vs);
}

export async function gridTabs() {
  const r = await db.execute(sql`
    SELECT p.item_type_id AS id, t.name, count(DISTINCT p.id)::int AS products, count(v.id)::int AS skus
    FROM products p LEFT JOIN variants v ON v.product_id = p.id LEFT JOIN item_types t ON t.id = p.item_type_id
    GROUP BY p.item_type_id, t.name ORDER BY t.name NULLS FIRST`);
  return r.rows.map((x: any) => ({ id: x.id ?? 'none', name: x.id ? x.name ?? x.id : 'No item type yet', products: x.products, skus: x.skus }));
}

// ---------------------------------------------------------------- saving
export interface CellChange { variantId: string; key: string; value: any }

/**
 * Store edits as overrides. A value shared by every SKU of a product is stored once on the
 * product (so the parent gets it too); values that differ are stored per SKU.
 * Empty value = back to the automatic value. "(none)" = send nothing.
 */
export async function saveCells(cells: CellChange[], opts: { auto?: boolean } = {}) {
  const valid = cells.filter((c) => c.variantId && c.key && (!c.key.startsWith('_') || c.key === ITEM_TYPE_KEY));
  if (!valid.length) return { products: 0, cells: 0 };
  const vIds = [...new Set(valid.map((c) => c.variantId))];
  const touchedVs = await db.select({ id: schema.variants.id, productId: schema.variants.productId }).from(schema.variants).where(inArray(schema.variants.id, vIds));
  const productOf = new Map(touchedVs.map((v) => [v.id, v.productId]));
  const byProduct = new Map<string, CellChange[]>();
  for (const c of valid) { const pid = productOf.get(c.variantId); if (pid) byProduct.set(pid, [...(byProduct.get(pid) ?? []), c]); }
  let count = 0;
  for (const [pid, list] of byProduct) {
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, pid) });
    if (!p) continue;
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, pid));
    const pov: Record<string, any> = { ...(p.overrides as any) };
    const vov = new Map(vs.map((v) => [v.id, { ...(v.overrides as any) } as Record<string, any>]));
    // "auto" flags: which stored values came from Auto-map (shown with an auto badge until edited)
    const pAuto = new Set(autoKeys(p));
    const vAuto = new Map(vs.map((v) => [v.id, new Set(variantAutoKeys(v))]));
    let itemTypeId: string | null | undefined;
    const keys = new Set<string>();
    for (const c of list) {
      if (c.key === ITEM_TYPE_KEY) { itemTypeId = c.value ? String(c.value) : null; count++; continue; }
      keys.add(c.key);
    }
    for (const key of keys) {
      const want = new Map<string, string | undefined>(vs.map((v) => [v.id, ovText(vov.get(v.id)![key] ?? pov[key])]));
      const flag = new Map<string, boolean>(vs.map((v) => [v.id, vov.get(v.id)![key] !== undefined ? vAuto.get(v.id)!.has(key) : pAuto.has(key)]));
      for (const c of list.filter((x) => x.key === key)) {
        const raw = Array.isArray(c.value) ? c.value.join('|') : c.value === null || c.value === undefined ? '' : String(c.value).trim();
        want.set(c.variantId, raw === '' || /^\(+\s*auto\s*\)+$/i.test(raw) || raw.toLowerCase() === 'auto' ? undefined : raw); // "(auto)" = back to the automatic value
        flag.set(c.variantId, !!opts.auto);
        count++;
      }
      const vals = [...want.values()];
      pAuto.delete(key);
      for (const s of vAuto.values()) s.delete(key);
      if (vals.every((x) => x !== undefined && x === vals[0])) {
        pov[key] = vals[0];
        for (const o of vov.values()) delete o[key];
        if ([...flag.values()].every(Boolean)) pAuto.add(key);
        else for (const [id, f] of flag) if (f) { vov.get(id)![key] = vals[0]; vAuto.get(id)!.add(key); }
      } else {
        delete pov[key];
        for (const [id, x] of want) {
          const o = vov.get(id)!;
          if (x === undefined) delete o[key]; else { o[key] = x; if (flag.get(id)) vAuto.get(id)!.add(key); }
        }
      }
    }
    if (pAuto.size) pov._auto = [...pAuto].filter((k) => pov[k] !== undefined); else delete pov._auto;
    if (!pov._auto?.length) delete pov._auto;
    for (const v of vs) {
      const o = vov.get(v.id)!;
      const a = [...vAuto.get(v.id)!].filter((k) => o[k] !== undefined);
      if (a.length) o._auto = a; else delete o._auto;
    }
    const set: any = { overrides: pov };
    if (itemTypeId !== undefined) set.itemTypeId = itemTypeId;
    await db.update(schema.products).set(set).where(eq(schema.products.id, pid));
    for (const v of vs) {
      const o = vov.get(v.id)!;
      if (JSON.stringify(o) !== JSON.stringify(v.overrides ?? {})) await db.update(schema.variants).set({ overrides: o }).where(eq(schema.variants.id, v.id));
    }
  }
  return { products: byProduct.size, cells: count };
}

// ---------------------------------------------------------------- smart auto-mapping
const stem = (t: string) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
const toks = (s: string | null | undefined) =>
  normalize((s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')).split(' ').filter((t) => t && t !== 's').map(stem);

const COLOR_SYNONYMS: Record<string, string[]> = {
  navy: ['blue'], denim: ['blue'], cobalt: ['blue'], teal: ['blue', 'green'], turquoise: ['blue'], indigo: ['blue'],
  taupe: ['beige', 'brown'], nude: ['beige'], sand: ['beige'], khaki: ['beige'], camel: ['brown', 'beige'], cognac: ['brown'], tan: ['brown'],
  chocolate: ['brown'], mocha: ['brown'], coffee: ['brown'], leopard: ['brown', 'multicolor'], tortoise: ['brown'],
  burgundy: ['red'], wine: ['red'], maroon: ['red'], cherry: ['red'], bordeaux: ['red'], rojo: ['red'],
  ivory: ['white', 'cream'], cream: ['white', 'beige'], bone: ['white', 'beige'], off: ['white'], blanco: ['white'], negro: ['black'],
  silver: ['gray', 'silver'], pewter: ['gray'], charcoal: ['gray'], grey: ['gray'], gris: ['gray'], gunmetal: ['gray'],
  gold: ['gold', 'yellow'], mustard: ['yellow'], olive: ['green'], mint: ['green'], sage: ['green'], emerald: ['green'], khakigreen: ['green'],
  blush: ['pink'], rose: ['pink'], fuchsia: ['pink'], coral: ['pink', 'orange'], salmon: ['pink'], lilac: ['purple'], lavender: ['purple'], plum: ['purple'],
  multi: ['multicolor', 'multi'], print: ['multicolor'], metallic: ['metallic'],
};
// women's EU -> US shoe sizes
const EU_TO_US: Record<string, string[]> = {
  '35': ['5'], '35.5': ['5.5'], '36': ['6', '5.5'], '36.5': ['6.5'], '37': ['7', '6.5'], '37.5': ['7.5'], '38': ['8', '7.5'], '38.5': ['8.5'],
  '39': ['8.5', '9'], '39.5': ['9'], '40': ['9.5', '9'], '40.5': ['10'], '41': ['10', '10.5'], '42': ['11', '10.5'], '43': ['12', '11.5'], '44': ['12.5', '13'],
};
const GENERIC_VALUES = new Set(['other', 'none', 'not applicable', 'n a', 'na', 'unknown', 'yes', 'no', 'not specified', 'see description']);

interface Corpus { color: string; size: string; fields: { t: string[]; w: number }[] }

function containsSeq(hay: string[], needle: string[]) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function pickByText(allowed: string[], corpus: Corpus, max: number, minWeight = 2): string[] {
  const scored: { v: string; s: number; w: number }[] = [];
  for (const v of allowed) {
    const n = normalize(v);
    if (GENERIC_VALUES.has(n)) continue;
    const t = toks(v);
    if (!t.length) continue;
    let best = 0, bestW = 0;
    for (const f of corpus.fields) if (f.w >= minWeight && containsSeq(f.t, t)) { const sc = f.w * t.length + v.length / 100; if (sc > best) { best = sc; bestW = f.w; } }
    if (best) scored.push({ v, s: best, w: bestW });
  }
  scored.sort((a, b) => b.s - a.s);
  // drop values that are only a part of a longer matched value ("Leather" when "Faux Leather" matched);
  // extra values (multi-select) only when they come from the title / options, never from the description
  const out: string[] = [];
  for (const x of scored) {
    if (out.some((o) => containsSeq(toks(o), toks(x.v)))) continue;
    if (out.length && x.w < 4) continue;
    out.push(x.v);
    if (out.length >= max) break;
  }
  return out;
}

function pickColor(allowed: string[], color: string): string | null {
  if (!color) return null;
  const direct = matchAllowed(color, allowed);
  if (direct) return direct;
  const parts = toks(color);
  for (const p of parts) { const m = matchAllowed(p, allowed); if (m) return m; }
  for (const p of parts) for (const syn of COLOR_SYNONYMS[p] ?? []) { const m = matchAllowed(syn, allowed); if (m) return m; }
  if (/[\/&+]| and /i.test(color)) { const m = allowed.find((a) => /multi/i.test(a)); if (m) return m; }
  return null;
}

function pickSize(allowed: string[], size: string): string | null {
  if (!size) return null;
  const direct = matchAllowed(size, allowed);
  if (direct) return direct;
  const num = size.replace(',', '.').match(/\d+(\.\d+)?/)?.[0];
  if (!num) return null;
  const candidates = [num, ...(Number(num) >= 34 && Number(num) <= 46 ? EU_TO_US[num] ?? [] : [])];
  for (const c of candidates) {
    const hit = allowed.filter((a) => { const ns = a.replace(',', '.').match(/\d+(\.\d+)?/g) ?? []; return ns.length === 1 && ns[0] === c; })
      .sort((a, b) => a.length - b.length)[0];
    if (hit) return hit;
  }
  return null;
}

// fields that must come from the product/manufacturer, not from text matching (secondary materials, licenses, claims…)
const NO_GUESS = /\b[2-9]\b|lining|licen[cs]e|personality|property|percentage|certif|claim|carbon|oeko|qualifier|warning|season|sport|theme|character|net content|contents/i;

function smartValue(a: Attribute, allowed: string[], c: Corpus): string | null {
  const name = a.name.toLowerCase();
  if (!a.required && NO_GUESS.test(a.name)) return null;
  const isYesNo = allowed.length > 0 && allowed.every((x) => /^(yes|no|true|false)$/i.test(x.trim()));
  if (isYesNo) return null; // never guess yes/no flags
  if (/colou?r/.test(name)) { const v = pickColor(allowed, c.color); if (v) return v; }
  if (/\bsize\b/.test(name) && !/group|range|type|chart/.test(name)) { const v = pickSize(allowed, c.size); if (v) return v; }
  // optional attributes: only fill from strong signals (options, title, product type, tags), never guess from the description
  const picked = pickByText(allowed, c, Math.max(1, a.maxSelections), a.required ? 2 : 3);
  if (picked.length) return picked.join('|');
  if (/age|audience/.test(name)) { const adult = allowed.find((x) => /^adults?$/i.test(x)); if (adult && c.fields.some((f) => f.t.some((t) => ['women', 'men', 'ladie', 'lady', 'mujer', 'adult'].includes(t)))) return adult; }
  return null;
}

const SHOE_SYNONYMS: [RegExp, string][] = [[/mary ?jane|ballerina|ballet/i, 'flat'], [/pump|stiletto|kitten heel/i, 'heel'], [/moccasin|penny/i, 'loafer'], [/espadrille/i, 'espadrille'], [/clog/i, 'mule'], [/trainer/i, 'sneaker']];
const GENERIC_TYPE_WORDS = new Set(['women', 'men', 'woman', 'man', 'girl', 'boy', 'kid', 'adult', 'and', 'or', 'the', 'casual', 'fashion', 'other', 'accessory', 'accessorie', 'shoe', 'clothing', 'apparel']);

function guessItemType(p: Product, types: { id: string; name: string }[]): string | null {
  const extra = SHOE_SYNONYMS.filter(([re]) => re.test(`${p.title} ${p.productType ?? ''}`)).map(([, w]) => w);
  const fields = [{ t: [...toks(p.productType), ...extra], w: 3 }, { t: [...toks(p.title), ...extra], w: 2 }, { t: (p.tags as string[]).flatMap(toks), w: 1 }];
  let best: { id: string; s: number } | null = null;
  for (const t of types) {
    const allWords = toks(t.name);
    const specific = allWords.filter((w) => !GENERIC_TYPE_WORDS.has(w));
    const words = specific.length ? specific : allWords;
    if (!words.length) continue;
    let s = 0;
    for (const f of fields) if (containsSeq(f.t, words)) s += f.w * words.length;
    if (!s) for (const w of words) for (const f of fields) if (f.t.includes(w)) s += f.w * 0.5;
    if (s && (!best || s > best.s)) best = { id: t.id, s };
  }
  return best?.id ?? null;
}

const NEVER_AUTOMAP = (k: string) => /^(descriptions\.(title|parent_title|long_description|bullets)|barcode\.value|brands\.name|digital_assets\.|child_variations\.|variation\.theme|item_type\.name)/.test(k);
const PKG: Record<string, string> = { depth: 'package_dimensions.measurements.depth', width: 'package_dimensions.measurements.width', height: 'package_dimensions.measurements.height', weight: 'package_dimensions.measurements.weight' };

export async function autoMap(variantIds: string[], opts: { overwrite?: boolean; setItemType?: boolean; defaults?: Record<string, any> } = {}) {
  if (!Array.isArray(variantIds) || !variantIds.length) throw Object.assign(new Error('Select at least one SKU'), { statusCode: 400 });
  const vs = await db.select().from(schema.variants).where(inArray(schema.variants.id, variantIds));
  const pids = [...new Set(vs.map((v) => v.productId))];
  let prods = await db.select().from(schema.products).where(inArray(schema.products.id, pids));
  const types = await db.select({ id: schema.itemTypes.id, name: schema.itemTypes.name }).from(schema.itemTypes);

  // 1) item type from product type / title / tags
  let itemTypesSet = 0;
  const guessedFor: string[] = [];
  if (opts.setItemType !== false) {
    for (const p of prods.filter((x) => !x.itemTypeId)) {
      const id = guessItemType(p, types);
      if (id) { await db.update(schema.products).set({ itemTypeId: id }).where(eq(schema.products.id, p.id)); itemTypesSet++; guessedFor.push(p.title); }
    }
    if (itemTypesSet) prods = await db.select().from(schema.products).where(inArray(schema.products.id, pids));
  }

  const changes: CellChange[] = [];
  const filled: Record<string, number> = {};
  const stillMissing: { sku: string; fields: string[] }[] = [];
  const noType: string[] = [];
  const noValues = new Set<string>();
  const rows = await buildRows(prods, vs);
  const taxoCache = new Map<string, Awaited<ReturnType<typeof loadTaxo>>>();
  for (const r of rows) {
    const p = prods.find((x) => x.id === r.productId)!;
    if (!p.itemTypeId) { noType.push(r.sku || r.variantTitle); continue; }
    if (!taxoCache.has(p.itemTypeId)) taxoCache.set(p.itemTypeId, await loadTaxo(p.itemTypeId));
    const taxo = taxoCache.get(p.itemTypeId)!;
    const v = vs.find((x) => x.id === r.variantId)!;
    const { sizeOption, colorOption } = detectOptions(p);
    const color = colorOption ? String((v.options as any)[colorOption] ?? '') : '';
    const size = sizeOption ? String((v.options as any)[sizeOption] ?? '') : '';
    const corpus: Corpus = {
      color, size,
      fields: [
        { t: toks(Object.values(v.options as Record<string, string>).join(' ')), w: 5 },
        { t: toks(p.title), w: 4 }, { t: toks(p.productType), w: 3 }, { t: (p.tags as string[]).flatMap(toks), w: 3 },
        { t: (p.bullets as string[]).flatMap(toks), w: 2 }, { t: toks(stripHtml(p.descriptionHtml)), w: 2 },
      ],
    };
    const missing: string[] = [];
    for (const a of taxo.attrs) {
      const key = attrKey(a);
      if (a.group === 'LOGISTICS' || LOGISTICS_KEYS.has(key) || NEVER_AUTOMAP(key)) continue;
      const current = r.values[key];
      const manual = r.sources[key] === 'variant' || r.sources[key] === 'product' || r.sources[key] === 'none';
      const allowed = taxo.values.get(a.id) ?? [];
      const currentOk = !!current && (a.type !== 'VALUE' || !allowed.length || current.split('|').every((x) => matchAllowed(x, allowed)));
      if (manual && !opts.overwrite) continue;
      if (currentOk && !opts.overwrite) continue;
      let val: string | null = null;
      const pkg = Object.entries(PKG).find(([, k]) => k === key)?.[0];
      if (pkg) val = current || (opts.defaults?.[pkg] ? String(opts.defaults[pkg]) : null);
      else if (a.type === 'VALUE') { if (!allowed.length) { noValues.add(a.name); } else val = smartValue(a, allowed, corpus); }
      if (val && val !== current) { changes.push({ variantId: r.variantId, key, value: val }); filled[a.name] = (filled[a.name] ?? 0) + 1; }
      if (!val && !currentOk && a.required) missing.push(a.name);
    }
    if (missing.length) stillMissing.push({ sku: r.sku || r.variantTitle, fields: missing });
  }
  const saved = await saveCells(changes, { auto: true });
  return { skus: rows.length, itemTypesSet, guessedFor, cells: saved.cells, filled, stillMissing, noType, valueListsMissing: [...noValues] };
}

// ---------------------------------------------------------------- Excel template
const INFO_COLS = [
  { key: 'external_id', name: 'Partner SKU' }, { key: '_product', name: 'Product (info)' }, { key: '_relationship', name: 'Relationship (info)' },
  { key: '_shopify_barcode', name: 'Shopify barcode (info)' }, { key: '_item_type', name: 'Item type' },
];
const colLetter = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export async function exportSheet(itemTypeId: string, rows: GridRow[], blankRows = 300): Promise<Buffer> {
  const it = await db.query.itemTypes.findFirst({ where: eq(schema.itemTypes.id, itemTypeId) });
  if (!it) throw Object.assign(new Error('Choose an item type for the sheet'), { statusCode: 400 });
  const cols = await gridColumns(itemTypeId);
  const types = await db.select({ name: schema.itemTypes.name }).from(schema.itemTypes).orderBy(asc(schema.itemTypes.name));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MeninaTargetHub';

  const info = wb.addWorksheet('Instructions');
  info.columns = [{ width: 120 }];
  [
    `Target Plus bulk mapping sheet · item type: ${it.name}`,
    '',
    'How to use:',
    '1. Fill the "Products" sheet. Row 1 = field name, row 2 = Target key (do not change), row 3 = required/optional. Data starts on row 4.',
    '2. Red headers are required by Target. Grey headers are optional.',
    '3. Cells with a dropdown only accept Target\'s allowed values (pick from the list). Several values: separate with |  (e.g. Leather|Suede).',
    '4. Leave a cell empty to keep the current / automatic value. Type (none) to send nothing for that field.',
    '5. Partner SKU must match the SKU in Target Hub. Info columns are not imported.',
    '6. Upload the file in Target Hub › Bulk mapping › Upload sheet. You will see what changed.',
    '',
    `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
  ].forEach((t, i) => { const c = info.getCell(i + 1, 1); c.value = t; if (i === 0) c.font = { bold: true, size: 14 }; });

  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  const all = [...INFO_COLS.map((c) => ({ ...c, info: true, col: null as GridColumn | null })), ...cols.map((c) => ({ key: c.key, name: c.name, info: false, col: c }))];

  // value lists (full lists from the database, not only the inline ones)
  const fullLists = new Map<string, string[]>();
  const attrIds = cols.filter((c) => c.type === 'VALUE' && c.attrId && c.valueCount).map((c) => c.attrId!) as string[];
  if (attrIds.length) {
    const vals = await db.select({ attrId: schema.attributeValues.attrId, name: schema.attributeValues.name }).from(schema.attributeValues).where(inArray(schema.attributeValues.attrId, attrIds));
    for (const v of vals) fullLists.set(v.attrId, [...(fullLists.get(v.attrId) ?? []), v.name]);
  }
  let listCol = 0;
  const listRange = (key: string, values: string[]) => {
    listCol++;
    const L = colLetter(listCol);
    lists.getCell(1, listCol).value = key;
    [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((v, i) => { lists.getCell(i + 2, listCol).value = v; });
    return `Lists!$${L}$2:$${L}$${values.length + 1}`;
  };
  const typeRange = listRange('item_type', types.map((t) => t.name));

  const RED = 'FFC0392B', GREY = 'FFD9D9D9', INFO = 'FFDCE6F2';
  const lastRow = 3 + Math.max(rows.length, blankRows);
  all.forEach((c, i) => {
    const n = i + 1;
    const h = ws.getCell(1, n), k = ws.getCell(2, n), r3 = ws.getCell(3, n);
    h.value = c.name; k.value = c.info ? (c.key === 'external_id' ? 'external_id' : '') : c.key;
    const req = !!c.col?.required || c.key === 'external_id';
    r3.value = c.info ? (c.key === 'external_id' ? 'Required · match key' : c.key === '_item_type' ? 'Pick from list' : 'Info only (not imported)') : `${req ? 'Required' : 'Optional'} · ${c.col!.type}${c.col!.maxSelections > 1 ? ` · up to ${c.col!.maxSelections}, separate with |` : ''}`;
    h.font = { bold: true, color: { argb: req && !c.info ? 'FFFFFFFF' : 'FF1F2937' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.info ? INFO : req ? RED : GREY } };
    k.font = { size: 8, color: { argb: 'FF6B7280' } };
    r3.font = { size: 8, italic: true, color: { argb: 'FF6B7280' } };
    h.alignment = { wrapText: true, vertical: 'middle' };
    ws.getColumn(n).width = c.key === '_product' ? 36 : c.col?.section === 'images' || c.key === 'descriptions.long_description' ? 40 : c.col?.section === 'bullets' || c.key === 'descriptions.title' ? 34 : 20;
    if (c.col?.description) h.note = c.col.description.slice(0, 400);
    let formula: string | null = null;
    if (c.key === '_item_type') formula = typeRange;
    else if (c.col?.type === 'VALUE' && c.col.attrId && (fullLists.get(c.col.attrId)?.length ?? 0) > 0) formula = listRange(c.key, fullLists.get(c.col.attrId)!);
    if (formula) {
      const dv = { type: 'list' as const, allowBlank: true, formulae: [formula], showErrorMessage: true, errorStyle: 'warning' as const, errorTitle: 'Not in Target\'s list', error: 'This value is not in Target\'s allowed list. Pick one from the dropdown (or type several separated with |).' };
      for (let r = 4; r <= lastRow; r++) ws.getCell(r, n).dataValidation = dv;
    }
  });
  ws.getRow(1).height = 36;

  rows.forEach((row, i) => {
    const r = i + 4;
    all.forEach((c, j) => {
      let v: any;
      if (c.key === 'external_id') v = row.sku;
      else if (c.key === '_product') v = [row.productTitle, Object.values(row.options).join(' / ')].filter(Boolean).join(' · ');
      else if (c.key === '_relationship') v = row.level;
      else if (c.key === '_shopify_barcode') v = row.barcode ?? '';
      else if (c.key === '_item_type') v = row.itemTypeName ?? '';
      else v = row.values[c.key] ?? '';
      if (v !== '' && v !== undefined && c.col && ['MEASURE', 'NUMBER', 'INTEGER'].includes(c.col.type) && /^\d+(\.\d+)?$/.test(String(v))) v = Number(v);
      ws.getCell(r, j + 1).value = v;
      if (c.info && c.key !== 'external_id' && c.key !== '_item_type') ws.getCell(r, j + 1).font = { color: { argb: 'FF6B7280' } };
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- sheet upload
const cellText = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x: any) => x.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
};

async function readGrid(buf: Buffer, filename: string): Promise<string[][]> {
  if (/\.csv$/i.test(filename)) {
    const text = buf.toString('utf8');
    const objs = parseCsv(text);
    if (!objs.length) return [];
    const head = Object.keys(objs[0]);
    return [head, ...objs.map((o) => head.map((h) => String(o[h] ?? '')))];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  for (const ws of wb.worksheets) {
    const out: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (c, i) => { vals[i - 1] = cellText(c.value).trim(); });
      out[n - 1] = Array.from(vals, (x) => x ?? '');
    });
    const grid = Array.from(out, (r) => r ?? []);
    if (grid.slice(0, 8).some((r) => r.includes('external_id'))) return grid;
  }
  return [];
}

export async function importSheet(buf: Buffer, filename: string) {
  const grid = await readGrid(buf, filename);
  const keyRowIdx = grid.findIndex((r, i) => i < 8 && r.includes('external_id'));
  if (keyRowIdx < 0) throw Object.assign(new Error('Could not find the header row with "external_id" (Partner SKU). Use the sheet downloaded from Target Hub or Target\'s bulk template.'), { statusCode: 400 });
  const keys = grid[keyRowIdx];
  // our sheet has a name row above the keys; item type column has no key there
  const names = keyRowIdx > 0 ? grid[keyRowIdx - 1] : [];
  const skuCol = keys.indexOf('external_id');
  const typeCol = names.findIndex((n) => /^item type$/i.test(n));
  const dataRows = grid.slice(keyRowIdx + 1).filter((r) => {
    const sku = (r[skuCol] ?? '').trim();
    // skip Target's note rows ("> Columns A-C…", "Not an item attribute", "Required · …")
    return sku && !/^(required|optional)\b/i.test(sku) && !sku.startsWith('>') && sku.split(/\s+/).length < 3;
  });
  const ignore = new Set(['external_id', 'parent_sku', 'relationship_type', 'action', 'item_type.name', '']);
  const types = await db.select({ id: schema.itemTypes.id, name: schema.itemTypes.name }).from(schema.itemTypes);
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t.id]));

  const skus = [...new Set(dataRows.map((r) => r[skuCol].trim()))];
  const vs = skus.length ? await db.select().from(schema.variants).where(inArray(schema.variants.sku, skus)) : [];
  const parents = skus.length ? await db.select().from(schema.products).where(inArray(schema.products.parentExternalId, skus)) : [];
  const rows = vs.length ? await allRows({ variantIds: vs.map((v) => v.id) }) : [];
  const rowById = new Map(rows.map((r) => [r.variantId, r]));
  const allowedByKey = new Map<string, { values: string[]; name: string }>();
  for (const itId of [...new Set(rows.map((r) => r.itemTypeId).filter(Boolean))] as string[]) {
    const taxo = await loadTaxo(itId);
    for (const a of taxo.attrs) if (a.type === 'VALUE') allowedByKey.set(`${itId}|${attrKey(a)}`, { values: taxo.values.get(a.id) ?? [], name: a.name });
  }

  const changes: CellChange[] = [];
  const typeChanges: CellChange[] = [];
  const unknown: string[] = [];
  const warnings: string[] = [];
  const parentProductChanges = new Map<string, Record<string, string>>();
  const touched = new Set<string>();
  for (const r of dataRows) {
    const sku = r[skuCol].trim();
    const targets = vs.filter((v) => v.sku === sku);
    const parent = parents.find((p) => p.parentExternalId === sku);
    if (!targets.length && !parent) { unknown.push(sku); continue; }
    if (parent && !targets.length) {
      const o: Record<string, string> = parentProductChanges.get(parent.id) ?? {};
      keys.forEach((k, i) => { const val = (r[i] ?? '').trim(); if (!ignore.has(k) && !k.startsWith('_') && val) o[k] = val; });
      parentProductChanges.set(parent.id, o);
      continue;
    }
    for (const v of targets) {
      const row = rowById.get(v.id);
      if (typeCol >= 0) {
        const tName = (r[typeCol] ?? '').trim();
        if (tName) {
          const tid = typeByName.get(tName.toLowerCase());
          if (!tid) warnings.push(`${sku}: item type "${tName}" is not one of your allowed item types`);
          else if (tid !== row?.itemTypeId) { typeChanges.push({ variantId: v.id, key: ITEM_TYPE_KEY, value: tid }); touched.add(v.id); }
        }
      }
      keys.forEach((k, i) => {
        if (ignore.has(k) || k.startsWith('_') || i === typeCol) return;
        const val = (r[i] ?? '').trim();
        if (!val) return;
        const cur = row?.values[k] ?? '';
        if (cur.trim().toLowerCase() === val.toLowerCase() && row?.sources[k] !== 'none') return;
        const allowed = row?.itemTypeId ? allowedByKey.get(`${row.itemTypeId}|${k}`) : undefined;
        if (allowed?.values.length && val !== '(none)') {
          const bad = val.split('|').map((x) => x.trim()).filter((x) => x && !matchAllowed(x, allowed.values));
          if (bad.length) warnings.push(`${sku} · ${allowed.name}: "${bad.join(', ')}" is not in Target's list`);
        }
        changes.push({ variantId: v.id, key: k, value: val });
        touched.add(v.id);
      });
    }
  }
  if (typeChanges.length) await saveCells(typeChanges);
  const saved = await saveCells(changes);
  for (const [pid, o] of parentProductChanges) {
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, pid) });
    if (p) await db.update(schema.products).set({ overrides: { ...(p.overrides as any), ...o } }).where(eq(schema.products.id, pid));
  }
  return {
    rows: dataRows.length, skusMatched: new Set(vs.map((v) => v.sku)).size, skusChanged: touched.size, cellsChanged: saved.cells + typeChanges.length,
    parentsUpdated: parentProductChanges.size, unknown, warnings: warnings.slice(0, 200), moreWarnings: Math.max(0, warnings.length - 200),
  };
}

// ---------------------------------------------------------------- one-click category setup
// Target guide order: ALLOWED_ITEM_TYPES report -> item types -> assignments (fields) -> attribute values (dropdowns)
export interface SetupState { running: boolean; step: string; done: number; total: number; error: string | null; finishedAt: string | null; itemTypes: number }
let setupState: SetupState = { running: false, step: '', done: 0, total: 0, error: null, finishedAt: null, itemTypes: 0 };
export const categorySetupStatus = () => setupState;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startCategorySetup(opts: { onlyIds?: string[]; withValues?: boolean; skipReport?: boolean } = {}) {
  if (setupState.running) return setupState;
  setupState = { running: true, step: 'Starting…', done: 0, total: 0, error: null, finishedAt: null, itemTypes: 0 };
  (async () => {
    try {
      if (!opts.onlyIds?.length && !opts.skipReport) {
        // Target's Insomnia collection asks for EXCEL; the guide shows JSON. Try both (and CSV) before giving up.
        const problems: string[] = [];
        let imported = false;
        for (const format of ['EXCEL', 'JSON', 'CSV']) {
          try {
            setupState.step = `Asking Target for your allowed item types (ALLOWED_ITEM_TYPES report, ${format})`;
            const r = await requestReport({ type: 'ALLOWED_ITEM_TYPES', format });
            let rep: any = r;
            for (let i = 0; i < 60 && rep.status !== 'COMPLETE'; i++) {
              if (['CANCELED', 'CANCELLED', 'ERROR', 'FAILED'].includes(String(rep.status).toUpperCase())) break;
              setupState.step = `Waiting for Target to build the report (${format}, ${String(rep.status ?? 'pending').toLowerCase()})…`;
              await sleep(i < 5 ? 3000 : 6000);
              rep = await refreshReport(r.id);
            }
            if (rep.status !== 'COMPLETE') {
              const errs = (rep.raw?.errors ?? []).map((e: any) => (typeof e === 'string' ? e : e?.message ?? e?.reason ?? JSON.stringify(e))).join('; ');
              problems.push(`${format}: report ${rep.status}${errs ? ` (${errs})` : ''}`);
              continue;
            }
            setupState.step = 'Downloading the report and saving item types';
            await importAllowedItemTypes(r.id);
            imported = true;
            break;
          } catch (e: any) {
            problems.push(`${format}: ${e?.message ?? e}`);
          }
        }
        if (!imported) throw new Error(`Target could not give the allowed item types report. ${problems.join(' · ')}`);
      }
      let types = await db.select().from(schema.itemTypes).orderBy(asc(schema.itemTypes.name));
      if (opts.onlyIds?.length) types = types.filter((t) => opts.onlyIds!.includes(t.id));
      setupState.itemTypes = types.length;
      setupState.total = types.length;
      for (const t of types) {
        setupState.step = `Loading Target fields for ${t.name}`;
        await syncAttributes(t.id);
        if (opts.withValues !== false) {
          setupState.step = `Loading dropdown values for ${t.name}`;
          await syncValues(t.id, true);
        }
        setupState.done++;
      }
      setupState.step = 'Done';
    } catch (e: any) {
      setupState.error = e?.message ?? String(e);
    } finally {
      setupState.running = false;
      setupState.finishedAt = new Date().toISOString();
    }
  })();
  return setupState;
}

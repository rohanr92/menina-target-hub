// Builds Target Plus item JSON (SA / VAP + VC) from a hub product, and validates it
// against the item type's taxonomy and Target's content + barcode rules.
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Attribute, Product, Variant } from '../db/schema.js';
import { getActiveEnv, getSync } from '../lib/settings.js';
import type { Field, ProductUpdate } from '../target/api.js';
import { mockUpc, validateBarcode } from './barcode.js';
import { descriptionWithoutList, fillTemplate, hasHtml, normalize, stripHtml, wordCount } from './text.js';

export type Theme = 'SA' | 'size' | 'color' | 'size and color';
export type SyncTitles = { child: string; standalone: string; parent: string; audience: string; sizeChart: string };

// ---------------- titles: "{brand} Women's {name} {color} {us} US / {eu} EU" ----------------
export function parseSizeChart(chart: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (chart || '').split(/[,;\n]+/)) {
    const [eu, us] = part.split(/[=:]/).map((x) => x?.trim().replace(',', '.'));
    if (eu && us) m.set(eu, us);
  }
  return m;
}
export function sizePair(size: string, chart: Map<string, string>): { us: string; eu: string } {
  const n = (size || '').replace(',', '.').match(/\d+(\.\d+)?/)?.[0];
  if (!n) return { us: '', eu: '' };
  if (Number(n) >= 30) return { eu: n, us: chart.get(n) ?? '' };
  const eu = [...chart.entries()].find(([, us]) => us === n)?.[0] ?? '';
  return { us: n, eu };
}
/** Shopify title without the brand, the audience word and a trailing color / size. */
export function cleanTitleName(title: string, brand: string, color: string, size: string): string {
  let t = ` ${title} `;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (brand) t = t.replace(new RegExp(`\\s${esc(brand)}(?=\\s)`, 'i'), ' ');
  t = t.replace(/\s(women'?s?|womens|woman'?s|ladies'?|mujer)(?=\s)/i, ' ');
  for (const x of [size, color]) if (x) t = t.replace(new RegExp(`[\\s\\-–/|,]*${esc(x)}\\s*$`, 'i'), ' ');
  return t.replace(/\s*[-–|,/]\s*$/, '').replace(/\s+/g, ' ').trim();
}
export function renderTitle(tpl: string, vars: Record<string, string>): string {
  const tok = (k: string) => (vars[k] ?? '').toString().trim();
  const withGroups = tpl.replace(/\[([^\]]*)\]/g, (_, inner: string) => {
    const ks = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return ks.every((k) => tok(k)) ? inner : '';
  });
  return withGroups.replace(/\{(\w+)\}/g, (_, k) => tok(k)).replace(/\s+/g, ' ').replace(/\s+([,/])/g, ' $1').trim();
}

export interface MappingRule {
  key: string; // mapped_property or attribute_id (the "name" sent to Target)
  source: 'auto' | 'field' | 'template' | 'constant' | 'skip';
  value?: string;
  valueMap?: Record<string, string>;
}

export interface Issue { level: 'error' | 'warning'; scope: string; field?: string; message: string }

export interface BuiltItem { variantId: string | null; sku: string; payload: ProductUpdate }
export interface TraceRow { key: string; value: string; source: string; original?: string }
export interface BuildResult {
  productId: string;
  theme: Theme;
  itemType: { id: string; name: string } | null;
  parent: ProductUpdate | null;
  items: BuiltItem[]; // SA items or VC children
  issues: Issue[];
  trace: Record<string, TraceRow[]>; // per external_id: where every value came from
}

const AUTO_DESC: Record<string, string> = {
  'brands.name': 'Shopify vendor', 'descriptions.title': 'Title rule (Settings › Product titles)', 'descriptions.parent_title': 'Title rule (Settings › Product titles)',
  'descriptions.long_description': 'Shopify description (HTML removed)', 'barcode.value': 'Shopify barcode',
  'digital_assets.images.primary_image_url': 'Shopify variant image / first image', 'digital_assets.images.parent_image_url': 'Shopify first image',
  'package_dimensions.measurements.weight': 'Shopify weight (lb)', 'child_variations.size': 'Shopify size option', 'child_variations.color': 'Shopify color option',
  'variation.theme': 'detected from options', 'compliance.import_designation': 'default', 'compliance.is_proposition_65': 'default', 'compliance.tax_category.tax_code': 'default for item type',
};
const autoDesc = (key: string) => AUTO_DESC[key] ?? (/bullets\[/.test(key) ? 'product bullets' : /alternate_image_urls/.test(key) ? 'Shopify images' : 'built-in');

// Logistics attributes are never part of item content (sent via product_logistics after creation)
const LOGISTICS_KEYS = new Set(['fulfillment.is_add_on', 'fulfillment.two_day_shipping_eligible', 'shipping_exclusion', 'seller_return_policy']);
const SA_FORBIDDEN = [/^variation\.theme$/, /^child_variations\./, /^descriptions\.parent_title$/, /^digital_assets\.images\.parent_image_url$/];
export const NEVER_ON_PARENT = [/^barcode\.value$/, /^descriptions\.title$/, /^child_variations\./];
export const SOURCE_FIELDS = [
  'product.title', 'product.vendor', 'product.productType', 'product.handle', 'product.description',
  'variant.sku', 'variant.barcode', 'variant.weightLb', 'variant.size', 'variant.color', 'variant.title', 'variant.price',
  'option:<Option name>', 'tag:<Prefix>', 'image:<n>', 'bullet:<n>',
];

const SIZE_RE = /size|talla|tamaño|eu|us size/i;
const COLOR_RE = /colou?r|farbe/i;

export function detectOptions(p: Product) {
  const names = (p.optionNames as string[]) ?? [];
  const sizeOption = p.sizeOption || names.find((n) => SIZE_RE.test(n)) || null;
  const colorOption = p.colorOption || names.find((n) => COLOR_RE.test(n)) || null;
  return { sizeOption, colorOption };
}

export function detectTheme(p: Product, vs: Variant[]): Theme {
  if (p.theme) return p.theme as Theme;
  if (vs.length <= 1) return 'SA';
  const { sizeOption, colorOption } = detectOptions(p);
  const distinct = (opt: string | null) => (opt ? new Set(vs.map((v) => (v.options as any)[opt])).size : 0);
  const s = distinct(sizeOption), c = distinct(colorOption);
  if (s > 1 && c > 1) return 'size and color';
  if (c > 1) return 'color';
  if (s > 1) return 'size';
  // fall back: first option name decides
  const first = ((p.optionNames as string[]) ?? [])[0];
  if (first && COLOR_RE.test(first)) return 'color';
  return 'size';
}

function defaultTaxCode(itemTypeName: string) {
  return /shoe|boot|sandal|sneaker|loafer|flat|heel|slipper|clog|mule|pump|oxford/i.test(itemTypeName) ? 'Shoes' : 'General Clothing';
}

interface Ctx {
  p: Product; v: Variant | null; vs: Variant[]; level: 'SA' | 'VAP' | 'VC'; theme: Theme;
  itemTypeName: string; size: string; color: string; stage: boolean; forceBrand: string; images: string[]; useMock: boolean;
  titles: SyncTitles;
  sizeValues?: Record<string, string>;
  sizeKeys: string[]; // the item type's own size fields (e.g. "Shoe Size"), used for the title
  /** Keep Target content + this item was copied from Target: send exactly Target's fields, add nothing automatic. */
  strict?: boolean;
  /** Suggestion mode: ignore every saved value and Target copy, build only from Shopify + mapping. */
  fresh?: boolean;
  /** Parent fields as Target has them (to tell Target's parent data apart from your own product edits). */
  parentOnTarget?: Map<string, string>;
  src?: string; original?: string; // set by resolve(): where the value came from
}

function sourceValue(spec: string, c: Ctx): string | undefined {
  const { p, v } = c;
  if (spec.startsWith('option:')) return v ? (v.options as any)[spec.slice(7)] : undefined;
  if (spec.startsWith('tag:')) {
    const prefix = spec.slice(4).toLowerCase();
    const tag = (p.tags as string[]).find((t) => t.toLowerCase().startsWith(prefix));
    return tag ? tag.slice(prefix.length).replace(/^[\s:=_-]+/, '').trim() : undefined;
  }
  if (spec.startsWith('image:')) return c.images[Number(spec.slice(6)) - 1];
  if (spec.startsWith('bullet:')) return (p.bullets as string[])[Number(spec.slice(7)) - 1];
  switch (spec) {
    case 'product.title': return p.title;
    case 'product.vendor': return p.vendor ?? undefined;
    case 'product.productType': return p.productType ?? undefined;
    case 'product.handle': return p.handle ?? undefined;
    case 'product.description': return descriptionWithoutList(p.descriptionHtml);
    case 'variant.sku': return v?.sku ?? undefined;
    case 'variant.barcode': return v?.barcode ?? undefined;
    case 'variant.weightLb': return v?.weightLb != null ? v.weightLb.toFixed(2) : undefined;
    case 'variant.size': return c.size || undefined;
    case 'variant.color': return c.color || undefined;
    case 'variant.title': return v?.title ?? undefined;
    case 'variant.price': return v?.price ?? undefined;
  }
  return undefined;
}

function tplVars(c: Ctx) {
  return {
    title: c.p.title, vendor: c.p.vendor, brand: c.stage ? c.forceBrand : c.p.vendor, size: c.size, color: c.color,
    productType: c.p.productType, sku: c.v?.sku, handle: c.p.handle, itemType: c.itemTypeName,
  };
}

/**
 * Title tokens come from the Target fields of the SKU (what you set in Bulk mapping / Auto-map),
 * falling back to Shopify: brand field, color field, size field (US) + the Shopify EU size.
 */
function titleVars(c: Ctx): Record<string, string> {
  const ov = (k: string) => { const v = (c.v?.overrides as any)?.[k] ?? (c.p.overrides as any)?.[k]; return v && v !== NONE ? String(Array.isArray(v) ? v[0] : v).split('|')[0].trim() : ''; };
  const chart = parseSizeChart(c.titles.sizeChart);
  // the same brand the Brand field sends (on stage that is the test brand, e.g. Valor Fitness)
  const brand = (c.stage && c.forceBrand ? c.forceBrand : '') || ov('brands.name') || c.p.vendor || '';
  const color = ov('child_variations.color') || c.color;
  // size typed / mapped in a Target size field wins over the Shopify option
  const fieldSize = ov('child_variations.size') || c.sizeKeys.map(ov).find(Boolean) || '';
  const fromField = fieldSize ? sizePair(fieldSize, chart) : { us: '', eu: '' };
  const fromShopify = sizePair(c.size, chart);
  const us = fromField.us || fromShopify.us;
  const eu = fromShopify.eu || fromField.eu || [...chart.entries()].find(([, x]) => x === us)?.[0] || '';
  return { brand, audience: c.titles.audience, name: cleanTitleName(c.p.title, c.p.vendor ?? brand, c.color, c.size), color, size: fieldSize || c.size, us, eu };
}

/** Built-in defaults for core Target attributes (used when the rule is "auto"). */
function autoValue(key: string, c: Ctx): string | undefined {
  const { p, v } = c;
  const bullet = key.match(/^descriptions\.bullets\[(\d+)\]$/);
  if (bullet) return (p.bullets as string[])[Number(bullet[1]) - 1];
  const alt = key.match(/^digital_assets\.images\.alternate_image_urls\[(\d+)\]$/);
  if (alt) {
    const primary = autoValue('digital_assets.images.primary_image_url', c);
    return c.images.filter((u) => u !== primary)[Number(alt[1]) - 1];
  }
  switch (key) {
    case 'brands.name': return c.stage && c.forceBrand ? c.forceBrand : p.vendor ?? undefined;
    case 'descriptions.title': return renderTitle(c.level === 'SA' ? c.titles.standalone : c.titles.child, titleVars(c)) || p.title;
    case 'descriptions.parent_title': return renderTitle(c.titles.parent, titleVars({ ...c, v: null, size: '', color: '' })) || p.title;
    case 'descriptions.long_description': return descriptionWithoutList(p.descriptionHtml) || stripHtml(p.descriptionHtml);
    case 'barcode.value': {
      if (!v) return undefined;
      if (c.stage && c.useMock && v.mockBarcode) return v.mockBarcode;
      return v.barcode ?? undefined;
    }
    case 'digital_assets.images.primary_image_url': return (c.level !== 'VAP' && v?.imageUrl) || c.images[0];
    case 'digital_assets.images.parent_image_url': return c.images[0];
    case 'package_dimensions.measurements.weight': return v?.weightLb ? v.weightLb.toFixed(2) : undefined;
    case 'child_variations.size': return (c.size && (c.sizeValues?.[c.size] ?? c.sizeValues?.[c.size.replace(',', '.')])) || c.size || undefined;
    case 'child_variations.color': return c.color || undefined;
    case 'variation.theme': return c.theme === 'SA' ? undefined : c.theme;
    case 'compliance.import_designation': return 'imported';
    case 'compliance.is_proposition_65': return 'No';
    case 'compliance.tax_category.tax_code': return defaultTaxCode(c.itemTypeName);
  }
  return undefined;
}

/** Override value meaning "send nothing for this attribute" (stops the automatic value). */
export const NONE = '(none)';

export function matchAllowed(value: string, allowed: string[]): string | null {
  if (!allowed.length) return value;
  const exact = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const n = normalize(value);
  const norm = allowed.find((a) => normalize(a) === n);
  if (norm) return norm;
  return null;
}

export interface Taxo { attrs: Attribute[]; values: Map<string, string[]>; rules: MappingRule[] }

export async function loadTaxo(itemTypeId: string): Promise<Taxo> {
  const attrs = await db.select().from(schema.attributes).where(eq(schema.attributes.itemTypeId, itemTypeId));
  const vals = await db.select({ attrId: schema.attributeValues.attrId, name: schema.attributeValues.name })
    .from(schema.attributeValues)
    .innerJoin(schema.attributes, eq(schema.attributes.id, schema.attributeValues.attrId))
    .where(eq(schema.attributes.itemTypeId, itemTypeId));
  const values = new Map<string, string[]>();
  for (const v of vals) values.set(v.attrId, [...(values.get(v.attrId) ?? []), v.name]);
  const profile = await db.query.mappingProfiles.findFirst({ where: eq(schema.mappingProfiles.itemTypeId, itemTypeId) });
  return { attrs, values, rules: (profile?.rules as MappingRule[]) ?? [] };
}

export const attrKey = (a: Attribute) => a.mappedProperty || a.attributeId;

/** Resolve one attribute value for an item. Returns raw string (may contain "|" for multi-values). */
function resolve(key: string, rule: MappingRule | undefined, c: Ctx): string | undefined {
  c.original = undefined;
  const vov = c.fresh ? undefined : (c.v?.overrides as any)?.[key];
  const ov = c.fresh ? undefined : vov ?? (c.p.overrides as any)?.[key];
  // stage only accepts the test brand, even if you typed your real brand on the SKU (your brand still goes in the title)
  if (key === 'brands.name' && c.stage && c.forceBrand) { c.src = 'Stage rule (Target requires Valor Fitness)'; return c.forceBrand; }
  if (ov === NONE) { c.src = 'Left empty on purpose'; return undefined; }
  if (c.strict) {
    // a field you edited for the whole product (Content editor) goes to every size and color
    const edited = ((c.p.overrides as any)?._edited ?? []) as string[];
    const pe = (c.p.overrides as any)?.[key];
    if (edited.includes(key) && pe !== undefined && pe !== null && pe !== '') { c.src = 'Your edit (all sizes & colors)'; return Array.isArray(pe) ? pe.join('|') : String(pe); }
    // existing Target item kept as it is on Target: only its own Target fields (plus your edits), never automatic extras
    if (vov !== undefined && vov !== null && vov !== '') { c.src = (c.v?.overrides as any)?._from_target ? 'From Target (existing item)' : 'Override (this variant)'; return Array.isArray(vov) ? vov.join('|') : String(vov); }
    const pov = (c.p.overrides as any)?.[key];
    if (c.level === 'VAP' && pov !== undefined && pov !== null && pov !== '') { c.src = 'From Target (existing item)'; return Array.isArray(pov) ? pov.join('|') : String(pov); }
    if (c.level !== 'VAP' && pov !== undefined && pov !== null && pov !== '') {
      const sv = Array.isArray(pov) ? pov.join('|') : String(pov);
      // the parent's own Target data (e.g. parent images) is not copied onto sizes; a product edit you made is
      if (c.parentOnTarget?.get(key) !== sv) { c.src = 'Override (this product)'; return sv; }
    }
    c.src = 'Not on Target · not sent (Keep Target content)';
    return undefined;
  }
  if (ov !== undefined && ov !== null && ov !== '') { c.src = vov !== undefined ? ((c.v?.overrides as any)?._from_target ? 'From Target (existing item)' : 'Override (this variant)') : ((c.p.overrides as any)?._from_target ? 'From Target (existing item)' : 'Override (this product)'); return Array.isArray(ov) ? ov.join('|') : String(ov); }
  if (key === 'brands.name' && c.stage && c.forceBrand) { c.src = 'Stage rule (Target requires Valor Fitness)'; return c.forceBrand; }
  if (key === 'barcode.value' && c.stage && c.useMock && c.v?.mockBarcode) { c.src = `Stage test barcode (real: ${c.v.barcode || 'none'})`; return c.v.mockBarcode; }
  let val: string | undefined;
  if (!rule || rule.source === 'auto') { val = autoValue(key, c); c.src = `Auto · ${autoDesc(key)}`; }
  else if (rule.source === 'skip') return undefined;
  else if (rule.source === 'constant') { val = rule.value; c.src = 'Constant (mapping)'; }
  else if (rule.source === 'field') { val = rule.value ? sourceValue(rule.value, c) : undefined; c.src = `Shopify ${rule.value}`; }
  else if (rule.source === 'template') { val = rule.value ? fillTemplate(rule.value, tplVars(c)) : undefined; c.src = `Template "${rule.value}"`; }
  if (val && rule?.valueMap && Object.keys(rule.valueMap).length) {
    const before = val;
    const parts = val.split('|').map((x) => x.trim());
    val = parts.map((x) => {
      const hit = Object.entries(rule.valueMap!).find(([from]) => from.toLowerCase() === x.toLowerCase());
      return hit && hit[1] ? hit[1] : x;
    }).join('|');
    if (val !== before) { c.original = before; c.src += ' → translated'; }
  }
  return val === undefined || val === null ? undefined : String(val).trim() || undefined;
}

function pushField(fields: Field[], key: string, raw: string, attr: Attribute | undefined, allowed: string[], issues: Issue[], scope: string) {
  const parts = attr && attr.maxSelections > 1 ? raw.split('|').map((x) => x.trim()).filter(Boolean) : [raw];
  if (attr && parts.length > attr.maxSelections) {
    issues.push({ level: 'warning', scope, field: key, message: `${attr.name}: ${parts.length} values given, max ${attr.maxSelections}; extra values dropped` });
    parts.length = attr.maxSelections;
  }
  for (let val of parts) {
    if (attr) {
      if (attr.type === 'VALUE' && allowed.length) {
        const m = matchAllowed(val, allowed);
        if (m) val = m;
        else issues.push({ level: 'warning', scope, field: key, message: `${attr.name}: "${val}" is not in Target's value list (Target will try approximate matching). Map it on the Mapping page.` });
      }
      if (['MEASURE', 'NUMBER'].includes(attr.type) && !/^\d+(\.\d+)?$/.test(val)) issues.push({ level: 'error', scope, field: key, message: `${attr.name}: "${val}" must be a number` });
      if (attr.type === 'INTEGER' && !/^\d+$/.test(val)) issues.push({ level: 'error', scope, field: key, message: `${attr.name}: "${val}" must be a whole number` });
    }
    fields.push({ name: key, value: val });
  }
}

export async function buildProduct(productId: string, opts: { checkOff?: boolean; fresh?: boolean } = {}): Promise<BuildResult> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) throw new Error('Product not found');
  const vs = (await db.select().from(schema.variants).where(eq(schema.variants.productId, productId)))
    .filter((v) => v.syncEnabled)
    .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));
  const issues: Issue[] = [];
  const theme = detectTheme(p, vs);
  const itemType = p.itemTypeId ? await db.query.itemTypes.findFirst({ where: eq(schema.itemTypes.id, p.itemTypeId) }) : null;
  const sync = await getSync();
  const stage = (await getActiveEnv()) === 'stage';
  const result: BuildResult = { productId, theme, itemType: itemType ? { id: itemType.id, name: itemType.name } : null, parent: null, items: [], issues, trace: {} };
  if (!itemType) { issues.push({ level: 'error', scope: 'product', message: 'Choose a Target item type for this product' }); return result; }
  if (!vs.length) { issues.push({ level: 'error', scope: 'product', message: 'No variants enabled for Target' }); return result; }

  // stage: make sure each variant has a stable mock barcode
  if (stage && sync.stage.useMockBarcodes) {
    for (const v of vs) if (!v.mockBarcode) {
      v.mockBarcode = mockUpc();
      await db.update(schema.variants).set({ mockBarcode: v.mockBarcode }).where(eq(schema.variants.id, v.id));
    }
  }
  const taxo = await loadTaxo(itemType.id);
  if (!taxo.attrs.length) issues.push({ level: 'error', scope: 'product', message: `Attributes for "${itemType.name}" are not loaded yet. Open Taxonomy and pull attributes.` });
  const ruleFor = new Map(taxo.rules.map((r) => [r.key, r]));
  const contentAttrs = taxo.attrs.filter((a) => a.group !== 'LOGISTICS');
  const { sizeOption, colorOption } = detectOptions(p);
  const images = [...new Set([...(p.images as string[])])];

  // Extra keys that may not be in the assignment list but are core
  const coreKeys = ['brands.name', 'descriptions.title', 'descriptions.parent_title', 'descriptions.long_description', 'barcode.value',
    'variation.theme', 'child_variations.size', 'child_variations.color', 'digital_assets.images.primary_image_url',
    'digital_assets.images.parent_image_url', 'compliance.import_designation', 'compliance.is_proposition_65', 'compliance.tax_category.tax_code',
    'package_dimensions.measurements.weight'];
  const logisticsKeys = new Set(taxo.attrs.filter((a) => a.group === 'LOGISTICS').map(attrKey));
  const keys = [...new Set([...contentAttrs.map(attrKey), ...coreKeys, ...taxo.rules.filter((r) => r.source !== 'skip').map((r) => r.key)])]
    .filter((k) => !logisticsKeys.has(k) && !LOGISTICS_KEYS.has(k));
  const attrByKey = new Map(contentAttrs.map((a) => [attrKey(a), a]));
  const sizeKeys = contentAttrs.filter((a) => /\bsize\b/i.test(a.name) && !/group|range|type|chart|system|grouping/i.test(a.name)).map(attrKey);

  const makeFields = (c: Ctx, scope: string): Field[] => {
    const fields: Field[] = [{ name: 'item_type.name', value: itemType.name }];
    const tr: TraceRow[] = (result.trace[scope] = [{ key: 'item_type.name', value: itemType.name, source: 'Item type chosen for the product' }]);
    for (const key of keys) {
      if (key === 'item_type.name') continue;
      if (c.level === 'SA' && SA_FORBIDDEN.some((re) => re.test(key))) continue;
      if (c.level === 'VAP' && NEVER_ON_PARENT.some((re) => re.test(key))) continue;
      if (c.level !== 'VAP' && key === 'digital_assets.images.parent_image_url') continue;
      if (c.level === 'VC') {
        if (key === 'child_variations.size' && !c.theme.includes('size')) continue;
        if (key === 'child_variations.color' && !c.theme.includes('color')) continue;
      }
      const raw = resolve(key, ruleFor.get(key), c);
      if (raw === undefined) continue;
      const a = attrByKey.get(key);
      const n = fields.length;
      pushField(fields, key, raw, a, a ? taxo.values.get(a.id) ?? [] : [], issues, scope);
      for (const f of fields.slice(n)) tr.push({ key, value: f.value, source: c.src ?? '', original: c.original ?? (f.value !== raw && !raw.includes('|') ? raw : undefined) });
    }
    return fields;
  };

  // "Keep Target content": items copied from Target are sent exactly as Target has them
  const locked = [true, 'true'].includes((p.overrides as any)?._keep_target_content ?? (p.overrides as any)?.keep_target_content);
  const parentOnTarget = new Map<string, string>();
  if (locked && p.targetParentId) {
    const t = await db.query.targetItems.findFirst({ where: eq(schema.targetItems.id, p.targetParentId) });
    for (const f of ((t?.fields ?? []) as { name: string; value: any }[])) if (f?.name && f.value != null && f.value !== '') parentOnTarget.set(f.name, Array.isArray(f.value) ? f.value.join('|') : String(f.value));
  }
  const strictFor = (v: Variant | null, level: Ctx['level']) => !opts.fresh && locked && !!(level === 'VAP' ? (p.overrides as any)?._from_target : (v?.overrides as any)?._from_target);

  const ctxFor = (v: Variant | null, level: Ctx['level']): Ctx => ({
    strict: strictFor(v, level), parentOnTarget, fresh: !!opts.fresh,
    p, v, vs, level, theme, itemTypeName: itemType.name, stage, forceBrand: sync.stage.forceBrand, images, useMock: sync.stage.useMockBarcodes, titles: sync.titles, sizeValues: sync.sizeValues ?? {}, sizeKeys,
    size: v && sizeOption ? String((v.options as any)[sizeOption] ?? '') : '',
    color: v && colorOption ? String((v.options as any)[colorOption] ?? '') : '',
  });

  // SKU checks
  const skus = vs.map((v) => v.sku?.trim() ?? '');
  skus.forEach((s, i) => { if (!s) issues.push({ level: 'error', scope: vs[i].title ?? vs[i].id, message: 'Variant has no SKU (external_id is required)' }); });
  const dup = skus.filter((s, i) => s && skus.indexOf(s) !== i);
  if (dup.length) issues.push({ level: 'error', scope: 'product', message: `Duplicate SKUs: ${[...new Set(dup)].join(', ')}` });

  if (theme === 'SA') {
    for (const v of vs) {
      const c = ctxFor(v, 'SA');
      const scope = v.sku ?? v.id;
      const fields = makeFields(c, scope);
      result.items.push({ variantId: v.id, sku: v.sku ?? '', payload: { external_id: v.sku ?? '', relationship_type: 'SA', fields } });
    }
  } else {
    const parentSku = p.parentExternalId || fillTemplate(sync.parentSkuPattern || 'VAP-{handle}', { handle: (p.handle ?? p.id).toUpperCase(), sku: vs[0]?.sku?.replace(/[-_][^-_]+$/, '') ?? '', title: p.title });
    const children = vs.map((v) => {
      const c = ctxFor(v, 'VC');
      const fields = makeFields(c, v.sku ?? v.id);
      return { variantId: v.id, sku: v.sku ?? '', payload: { external_id: v.sku ?? '', relationship_type: 'VC' as const, fields } };
    });
    // Parent: base parent fields + attributes identical across every child
    const pc = ctxFor(null, 'VAP');
    const parentBase = makeFields(pc, 'parent');
    const baseKeys = new Set(parentBase.map((f) => f.name));
    const common: Field[] = [];
    const childKeys = new Set(children.flatMap((ch) => ch.payload.fields.map((f) => f.name)));
    for (const key of childKeys) {
      if (baseKeys.has(key) || NEVER_ON_PARENT.some((re) => re.test(key)) || key === 'variation.theme') continue;
      const vals = children.map((ch) => ch.payload.fields.filter((f) => f.name === key).map((f) => f.value).join('|'));
      if (vals.every((x) => x && x === vals[0])) common.push(...children[0].payload.fields.filter((f) => f.name === key));
    }
    // a parent copied from Target keeps Target's own theme value (e.g. "Size & Color")
    const tTheme = pc.strict ? (p.overrides as any)?.['variation.theme'] : undefined;
    const themeVal = tTheme ? String(tTheme) : theme;
    // a kept size without its own theme still needs one when sent: use the parent's (Target requires it on sizes)
    for (const ch of children) {
      const v = vs.find((x) => x.id === ch.variantId) ?? null;
      if (strictFor(v, 'VC') && !ch.payload.fields.some((f) => f.name === 'variation.theme')) {
        ch.payload.fields.push({ name: 'variation.theme', value: themeVal });
        (result.trace[ch.sku || ch.variantId] ??= []).push({ key: 'variation.theme', value: themeVal, source: 'Parent theme (sizes need it)' });
      }
    }
    const parentFields = [...parentBase.filter((f) => f.name !== 'variation.theme'), { name: 'variation.theme', value: themeVal }, ...(pc.strict ? [] : common)];
    const commonKeys = new Set(common.map((f) => f.name));
    const firstTrace = result.trace[children[0]?.sku || children[0]?.variantId || ''] ?? [];
    result.trace.parent = [
      ...(result.trace.parent ?? []).filter((t) => t.key !== 'variation.theme'),
      { key: 'variation.theme', value: themeVal, source: tTheme ? 'From Target (existing item)' : 'Detected from options' },
      ...(pc.strict ? [] : firstTrace).filter((t) => commonKeys.has(t.key)).map((t) => ({ ...t, source: `${t.source} (same on every child, so set on parent)` })),
    ];
    result.parent = { external_id: parentSku, relationship_type: 'VAP', fields: parentFields };
    result.items = children;
    if (skus.includes(parentSku)) issues.push({ level: 'error', scope: 'parent', message: `Parent SKU ${parentSku} must differ from child SKUs` });
    const combos = children.map((ch) => ch.payload.fields.filter((f) => f.name.startsWith('child_variations.')).map((f) => f.value).join('/'));
    const dupCombo = combos.filter((x, i) => combos.indexOf(x) !== i);
    if (dupCombo.length) issues.push({ level: 'error', scope: 'product', message: `Two children share the same variation value: ${[...new Set(dupCombo)].join(', ')}` });
  }

  // items kept as they are on Target: check them together with their parent (Target keeps shared fields like
  // PFAS, theme and images on the parent), and never block them for something Target already approved
  const kept = new Set<string>();
  if (theme === 'SA') { for (const v of vs) if (strictFor(v, 'SA')) kept.add(v.sku ?? v.id); }
  else { for (const v of vs) if (strictFor(v, 'VC')) kept.add(v.sku ?? v.id); if (strictFor(null, 'VAP')) kept.add('parent'); }
  validateContent(result, contentAttrs, kept);
  // sizes that are unlisted on Target or switched to Send OFF are never sent, so their problems don't matter
  const sendOn = (v: Variant) => { const x = (v.overrides as any)?._send; return x === true || x === false ? x : v.listingStatus !== 'UNLISTED'; };
  const off = new Set(vs.filter((v) => !sendOn(v)).map((v) => v.sku ?? v.id));
  if (off.size && !opts.checkOff) {
    result.issues = result.issues.filter((i) => !off.has(i.scope));
    result.issues.push({ level: 'warning', scope: 'product', message: `${off.size} size(s) are unlisted or Send OFF: not checked and never sent (${[...off].slice(0, 6).join(', ')}${off.size > 6 ? '…' : ''})` });
  }
  return result;
}

function get(fields: Field[], name: string) { return fields.filter((f) => f.name === name).map((f) => f.value); }

function validateContent(r: BuildResult, contentAttrs: Attribute[], kept: Set<string> = new Set()) {
  const all = [...(r.parent ? [{ scope: 'parent', p: r.parent }] : []), ...r.items.map((i) => ({ scope: i.sku || 'item', p: i.payload }))];
  for (const { scope, p } of all) {
    const isKept = kept.has(scope);
    const before = r.issues.length;
    // a kept child is checked together with its parent's fields (Target shares parent fields with the sizes)
    const f = isKept && p.relationship_type === 'VC' && r.parent
      ? [...p.fields, ...r.parent.fields.filter((x) => !p.fields.some((y) => y.name === x.name))]
      : p.fields;
    const lvl = p.relationship_type;
    const title = lvl === 'VAP' ? get(f, 'descriptions.parent_title')[0] : get(f, 'descriptions.title')[0];
    if (!title) r.issues.push({ level: 'error', scope, field: lvl === 'VAP' ? 'descriptions.parent_title' : 'descriptions.title', message: 'Title is required' });
    else {
      if (title.length < 21) r.issues.push({ level: 'warning', scope, message: `Title is ${title.length} chars; Target wants 21-100 (max 150)` });
      if (title.length > 150) r.issues.push({ level: 'error', scope, message: `Title is ${title.length} chars; max is 150` });
      else if (title.length > 100) r.issues.push({ level: 'warning', scope, message: `Title is ${title.length} chars; keep under 100 to avoid truncation on mobile` });
    }
    if (lvl === 'VC' && !get(f, 'descriptions.parent_title')[0]) r.issues.push({ level: 'error', scope, message: 'VC needs descriptions.parent_title (links it to the parent)' });
    const desc = get(f, 'descriptions.long_description')[0] ?? '';
    if (!desc) r.issues.push({ level: 'error', scope, field: 'descriptions.long_description', message: 'Description is required' });
    else {
      if (hasHtml(desc)) r.issues.push({ level: 'error', scope, message: 'Description cannot contain HTML' });
      if (wordCount(desc) < 50) r.issues.push({ level: 'warning', scope, message: `Description has ${wordCount(desc)} words; Target requires at least 50` });
      if (desc.length > 4000) r.issues.push({ level: 'warning', scope, message: `Description is ${desc.length} chars; content guide max is 4000` });
    }
    const bullets = f.filter((x) => /^descriptions\.bullets\[\d+\]$/.test(x.name) && x.value);
    if (lvl !== 'VC' && bullets.length < 2) r.issues.push({ level: 'error', scope, message: `${bullets.length} feature bullets; at least 2 required` });
    for (const b of bullets) {
      if (b.value.length > 120) r.issues.push({ level: 'error', scope, field: b.name, message: `Bullet over 120 chars` });
      if (hasHtml(b.value)) r.issues.push({ level: 'error', scope, field: b.name, message: 'Bullets cannot contain HTML' });
    }
    if (!get(f, 'brands.name')[0]) r.issues.push({ level: 'error', scope, message: 'Brand is required' });
    if (lvl !== 'VAP') {
      const bc = validateBarcode(get(f, 'barcode.value')[0]);
      if (bc.level !== 'ok') r.issues.push({ level: bc.level, scope, field: 'barcode.value', message: bc.message });
      if (!get(f, 'digital_assets.images.primary_image_url')[0]) r.issues.push({ level: 'error', scope, message: 'Primary image is required' });
      const alts = f.filter((x) => x.name.startsWith('digital_assets.images.alternate_image_urls') && x.value).length;
      if (alts < 2) r.issues.push({ level: 'warning', scope, message: `${alts} alternate images; Target asks for at least 2` });
      for (const a of contentAttrs.filter((x) => x.required)) {
        const k = attrKey(a);
        if (SA_FORBIDDEN.some((re) => re.test(k)) && lvl === 'SA') continue;
        if (!f.some((x) => x.name === k && x.value)) r.issues.push({ level: 'error', scope, field: k, message: `Required attribute missing: ${a.name} (${k})` });
      }
      for (const k of ['package_dimensions.measurements.depth', 'package_dimensions.measurements.width', 'package_dimensions.measurements.height', 'package_dimensions.measurements.weight']) {
        if (contentAttrs.some((a) => a.required && attrKey(a) === k)) continue; // already reported above
        if (!f.some((x) => x.name === k && x.value)) r.issues.push({ level: 'error', scope, field: k, message: `Missing ${k.split('.').pop()} (package dimensions are required for SA and VC)` });
      }
    } else if (get(f, 'barcode.value').length) {
      r.issues.push({ level: 'error', scope, message: 'Parent (VAP) must not include a barcode' });
    }
    if (lvl === 'VC' && !get(f, 'variation.theme')[0]) r.issues.push({ level: 'error', scope, message: 'VC needs variation.theme' });
    if (lvl === 'VC') {
      if (r.theme.includes('size') && !get(f, 'child_variations.size')[0]) r.issues.push({ level: 'error', scope, field: 'child_variations.size', message: 'No size value for this child. Set the size option on the product (Target setup › Size option) or an override.' });
      if (r.theme.includes('color') && !get(f, 'child_variations.color')[0]) r.issues.push({ level: 'error', scope, field: 'child_variations.color', message: 'No color value for this child. Set the color option on the product (Target setup › Color option) or an override.' });
    }
    if (isKept) {
      // Target already has (and approved) this item like this: show what is missing, but don't block sending
      for (const i of r.issues.slice(before)) if (i.level === 'error') { i.level = 'warning'; i.message += ' (same as on Target now)'; }
    }
  }
  // de-duplicate identical messages
  const seen = new Set<string>();
  r.issues = r.issues.filter((i) => { const k = `${i.level}|${i.scope}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Target prices from Shopify price fields according to the price rules. */
export async function computePrice(v: Variant) {
  const { price: rule } = await getSync();
  const ov = v.overrides as any;
  const num = (x: any) => (x == null || x === '' ? null : Number(x));
  const round = (n: number) => {
    let x = Math.round(n * rule.multiplier * 100) / 100;
    if (rule.roundTo99) x = Math.max(0.99, Math.ceil(x) - 0.01);
    return Math.round(x * 100) / 100;
  };
  const price = num(v.price);
  const compare = num(v.compareAtPrice);
  if (ov?.list_price) {
    return { list_price: Number(ov.list_price), offer_price: ov.offer_price ? Number(ov.offer_price) : undefined, map_price: ov.map_price ? Number(ov.map_price) : undefined };
  }
  // price rule for this SKU (Price & inventory › Price rule): fixed price, or Shopify price ± %
  const pr = ov?._price_rule as { mode: 'percent' | 'fixed'; value: number } | undefined;
  if (pr?.mode === 'fixed' && Number(pr.value) > 0) { const x = round(Number(pr.value) / (rule.multiplier || 1)); return { list_price: x }; }
  if (!price || price <= 0) return null;
  const pct = pr?.mode === 'percent' ? 1 + Number(pr.value) / 100 : 1;
  const list = rule.listFrom === 'compare_at_or_price' && compare && compare > price ? compare : price;
  const out: { list_price: number; offer_price?: number; map_price?: number } = { list_price: round(list * pct) };
  // Target rule: offer (sale) price must be lower than the list price; MAP not above list
  if (rule.offerFrom === 'price' && price < list) out.offer_price = round(price * pct);
  if (rule.mapFrom === 'price') out.map_price = Math.min(round(price * pct), out.list_price);
  return out;
}

export function priceIssues(p: { list_price: number; offer_price?: number; map_price?: number } | null): string[] {
  if (!p) return ['No price available'];
  const out: string[] = [];
  if (!(p.list_price > 0)) out.push('List price must be greater than 0');
  if (p.offer_price != null && p.offer_price > p.list_price) out.push('Offer price cannot be higher than list price');
  if (p.map_price != null && p.map_price > p.list_price) out.push('MAP cannot be higher than list price');
  return out;
}

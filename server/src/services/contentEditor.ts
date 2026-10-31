// Content editor (product page): edit the shared content of a product once — it goes to every size and color.
// Each field shows what is sent now and the hub's own suggestion (built only from Shopify + your mapping).
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { NONE, attrKey, buildProduct, loadTaxo } from './builder.js';
import { sendEnabled } from './items.js';

/** Never edited here: they are different for every size / color, or have their own place. */
const SKIP = [/^item_type\.name$/, /^barcode\.value$/, /^descriptions\.title$/, /^child_variations\./, /^variation\.theme$/, /^digital_assets\.images\./, /^external_id$/];
const NAMES: Record<string, string> = {
  'descriptions.parent_title': 'Parent title', 'descriptions.long_description': 'Description', 'brands.name': 'Brand',
  'compliance.import_designation': 'Import designation', 'compliance.is_proposition_65': 'Prop 65', 'compliance.tax_category.tax_code': 'Tax code',
};
const ORDER = (k: string) => (k === 'descriptions.parent_title' ? 0 : k === 'descriptions.long_description' ? 1 : k.startsWith('descriptions.bullets') ? 2 + Number(k.match(/\[(\d+)\]/)?.[1] ?? 0) / 100 : k === 'brands.name' ? 3 : 4);

export async function contentEditor(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  if (!p.itemTypeId) throw Object.assign(new Error('Choose a Target item type first (Target setup › Item type).'), { statusCode: 400 });
  const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  const [now, fresh, taxo] = await Promise.all([buildProduct(productId, { checkOff: true }), buildProduct(productId, { fresh: true, checkOff: true }), loadTaxo(p.itemTypeId)]);
  const attrs = taxo.attrs.filter((a) => a.group !== 'LOGISTICS');
  const byKey = new Map(attrs.map((a) => [attrKey(a), a]));
  const isSizeOrColor = (k: string) => { const a = byKey.get(k); return !!a && ((/\bsize\b/i.test(a.name) && !/group|grouping|system|type/i.test(a.name)) || /colou?r/i.test(a.name)); };
  const skip = (k: string) => SKIP.some((re) => re.test(k)) || isSizeOrColor(k);

  // value per key: the parent's, else the first size that is selling
  const pick = (r: typeof now) => {
    const out = new Map<string, string>();
    const sellingIds = new Set(vs.filter((v) => sendEnabled(v)).map((v) => v.id));
    const child = r.items.find((i) => i.variantId && sellingIds.has(i.variantId)) ?? r.items[0];
    for (const f of [...(r.parent?.fields ?? []), ...(child?.payload.fields ?? [])]) {
      if (skip(f.name)) continue;
      const cur = out.get(f.name);
      if (cur === undefined) out.set(f.name, String(f.value));
      else if (byKey.get(f.name)?.maxSelections && (byKey.get(f.name)!.maxSelections > 1) && !(r.parent?.fields ?? []).some((x) => x.name === f.name)) out.set(f.name, `${cur}|${f.value}`);
    }
    return out;
  };
  const cur = pick(now), sug = pick(fresh);
  const edited = new Set(((p.overrides as any)?._edited ?? []) as string[]);
  const keys = [...new Set([...cur.keys(), ...sug.keys(), ...attrs.map(attrKey).filter((k) => !skip(k))])];
  const fields = keys.map((k) => {
    const a = byKey.get(k);
    const values = a ? taxo.values.get(a.id) ?? [] : [];
    const bn = k.match(/^descriptions\.bullets\[(\d+)\]$/)?.[1];
    return {
      key: k, name: a?.name ?? NAMES[k] ?? (bn ? `Bullet ${bn}` : k), required: !!a?.required, type: a?.type ?? 'TEXT', multi: (a?.maxSelections ?? 1) > 1,
      values: values.slice(0, 600), current: cur.get(k) ?? '', suggestion: sug.get(k) ?? '', edited: edited.has(k),
      long: k === 'descriptions.long_description',
    };
  }).sort((x, y) => ORDER(x.key) - ORDER(y.key) || Number(y.required) - Number(x.required) || x.name.localeCompare(y.name));
  // make room for new bullets up to 8
  const bullets = fields.filter((f) => f.key.startsWith('descriptions.bullets')).length;
  for (let n = bullets + 1; n <= Math.max(8, bullets); n++) if (!fields.some((f) => f.key === `descriptions.bullets[${n}]`)) {
    const at = fields.findIndex((f) => ORDER(f.key) > 2 + n / 100);
    fields.splice(at < 0 ? fields.length : at, 0, { key: `descriptions.bullets[${n}]`, name: `Bullet ${n}`, required: false, type: 'TEXT', multi: false, values: [], current: '', suggestion: '', edited: false, long: false });
  }
  return { fields, keepTarget: [true, 'true'].includes((p.overrides as any)?._keep_target_content ?? (p.overrides as any)?.keep_target_content) };
}

/**
 * Save edited fields for the whole product: the value is stored once on the product and removed from every size,
 * so the parent and all sizes / colors send the same value. Empty = send nothing for that field.
 */
export async function saveContent(productId: string, values: Record<string, string | null>) {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  const keys = Object.keys(values ?? {}).filter((k) => k && !k.startsWith('_') && !SKIP.some((re) => re.test(k)));
  if (!keys.length) return { saved: 0 };
  const ov: Record<string, any> = { ...((p.overrides as any) ?? {}) };
  const edited = new Set((ov._edited ?? []) as string[]);
  for (const k of keys) {
    const v = values[k] === null || values[k] === undefined ? '' : String(values[k]).trim();
    ov[k] = v === '' ? NONE : v;
    edited.add(k);
  }
  ov._edited = [...edited];
  if (ov._auto) ov._auto = (ov._auto as string[]).filter((k) => !keys.includes(k));
  await db.update(schema.products).set({ overrides: ov, updatedAt: new Date() }).where(eq(schema.products.id, productId));
  const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, productId));
  for (const v of vs) {
    const o: Record<string, any> = { ...((v.overrides as any) ?? {}) };
    let changed = false;
    for (const k of keys) if (k in o) { delete o[k]; changed = true; }
    if (o._auto) o._auto = (o._auto as string[]).filter((k) => !keys.includes(k));
    if (changed) await db.update(schema.variants).set({ overrides: o }).where(eq(schema.variants.id, v.id));
  }
  return { saved: keys.length, sizes: vs.length };
}

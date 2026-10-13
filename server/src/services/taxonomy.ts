// Item types, attribute assignments and value lists (Test plan: Data Collection).
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as T from '../target/api.js';

/** Parse an ALLOWED_ITEM_TYPES report (JSON array/object, CSV or XLSX) into {id,name}. */
export async function parseAllowedItemTypes(data: any, contentType = ''): Promise<{ id: string; name: string; raw: any }[]> {
  let rows: any[] = [];
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || /sheet|excel|octet/.test(contentType)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(data as any) as any);
    // Target's Excel report may have a title row first: find the header row (has an id and a name column) on any sheet
    for (const ws of wb.worksheets) {
      const grid: string[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        const vals: string[] = [];
        row.eachCell({ includeEmpty: true }, (c, i) => { const v: any = c.value; vals[i - 1] = String(v?.text ?? v?.result ?? v ?? '').trim(); });
        grid[n - 1] = Array.from(vals, (x) => x ?? '');
      });
      const h = grid.findIndex((r, i) => i < 15 && r && r.some((x) => /item.?type.?id|taxonomy.?id|^id$/i.test(x)) && r.some((x) => /name|item.?type$/i.test(x)));
      if (h < 0) continue;
      const header = grid[h];
      for (const r of grid.slice(h + 1)) {
        if (!r) continue;
        const o: any = {};
        header.forEach((k, i) => { if (k) o[k] = r[i]; });
        rows.push(o);
      }
      if (rows.length) break;
    }
  } else if (typeof data === 'string') {
    const t = data.trim();
    if (t.startsWith('[') || t.startsWith('{')) rows = toArray(JSON.parse(t));
    else rows = parseCsv(t);
  } else {
    rows = toArray(data);
  }
  const out: { id: string; name: string; raw: any }[] = [];
  for (const r of rows) {
    const keys = Object.keys(r);
    const idKey = keys.find((k) => /item.?type.?id/i.test(k)) ?? keys.find((k) => /^(id|taxonomy.?id)$/i.test(k));
    const nameKey = keys.find((k) => /item.?type.?name/i.test(k)) ?? keys.find((k) => /^(name|item.?type)$/i.test(k));
    const id = idKey ? String(r[idKey] ?? '').trim() : '';
    const name = nameKey ? String(r[nameKey] ?? '').trim() : '';
    if (id && name) out.push({ id, name, raw: r });
  }
  return out;
}

function toArray(j: any): any[] {
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'items', 'item_types', 'allowed_item_types', 'results']) if (Array.isArray(j?.[k])) return j[k];
  return [j];
}

export function parseCsv(text: string): any[] {
  const lines: string[][] = [];
  let cur: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); lines.push(cur); cur = []; field = '';
    } else field += c;
  }
  if (field || cur.length) { cur.push(field); lines.push(cur); }
  const [head, ...rest] = lines.filter((l) => l.some((x) => x.trim()));
  if (!head) return [];
  return rest.map((l) => Object.fromEntries(head.map((h, i) => [h.trim(), l[i]])));
}

export async function saveItemTypes(list: { id: string; name: string; raw?: any }[]) {
  for (const it of list) {
    await db.insert(schema.itemTypes).values({ id: it.id, name: it.name, raw: it.raw ?? null })
      .onConflictDoUpdate({ target: schema.itemTypes.id, set: { name: it.name, raw: it.raw ?? null, updatedAt: new Date() } });
  }
  return list.length;
}

/** Pull assignments (attributes) for an item type and store them. */
export async function syncAttributes(itemTypeId: string) {
  const assignments = await T.getAssignments(itemTypeId);
  const seen = new Set<string>();
  for (const a of assignments) {
    const attr = a.attribute ?? {};
    const attributeId = String(a.attribute_id ?? attr.id);
    if (!attributeId || seen.has(attributeId)) continue;
    seen.add(attributeId);
    const row = {
      itemTypeId,
      attributeId,
      taxonomyId: String(a.taxonomy_id ?? itemTypeId),
      name: attr.name ?? attributeId,
      mappedProperty: attr.mapped_property || null,
      type: String(attr.type ?? 'TEXT').toUpperCase(),
      group: String(attr.attribute_group ?? 'SELLING').toUpperCase(),
      required: !!a.required,
      maxSelections: Number(a.max_selections ?? 1) || 1,
      description: attr.description ?? null,
      raw: a,
    };
    await db.insert(schema.attributes).values(row).onConflictDoUpdate({
      target: [schema.attributes.itemTypeId, schema.attributes.attributeId],
      set: { ...row },
    });
  }
  await db.update(schema.itemTypes).set({ attributesFetchedAt: new Date() }).where(eq(schema.itemTypes.id, itemTypeId));
  return seen.size;
}

/** Pull value lists for VALUE and MEASURE attributes (many calls: runs throttled). */
export async function syncValues(itemTypeId: string, onlyMissing = true, onProgress?: (done: number, total: number) => void) {
  const attrs = await db.select().from(schema.attributes).where(and(
    eq(schema.attributes.itemTypeId, itemTypeId),
    inArray(schema.attributes.type, ['VALUE', 'MEASURE']),
  ));
  const todo = attrs.filter((a) => !onlyMissing || !a.valuesFetched);
  let done = 0;
  for (const a of todo) {
    const values = await T.getAttributeValues(a.taxonomyId, a.attributeId);
    await db.delete(schema.attributeValues).where(eq(schema.attributeValues.attrId, a.id));
    const rows = values
      .map((v: any) => ({ attrId: a.id, valueId: String(v.id ?? v.value_id ?? v.name), name: String(v.name ?? v.value ?? '') }))
      .filter((v: any) => v.name);
    const unique = [...new Map(rows.map((r: any) => [r.valueId, r])).values()];
    for (let i = 0; i < unique.length; i += 500) await db.insert(schema.attributeValues).values(unique.slice(i, i + 500)).onConflictDoNothing();
    await db.update(schema.attributes).set({ valuesFetched: true }).where(eq(schema.attributes.id, a.id));
    onProgress?.(++done, todo.length);
  }
  await db.update(schema.itemTypes).set({ valuesFetchedAt: new Date() }).where(eq(schema.itemTypes.id, itemTypeId));
  return todo.length;
}

export async function syncSetupData() {
  const dcs = await T.getDistributionCenters();
  const dcList = Array.isArray(dcs) ? dcs : dcs?.data ?? [];
  for (const d of dcList) {
    await db.insert(schema.distributionCenters).values({ id: String(d.id), name: d.name ?? String(d.id), raw: d })
      .onConflictDoUpdate({ target: schema.distributionCenters.id, set: { name: d.name ?? String(d.id), raw: d } });
  }
  const methods = await T.getShippingMethods();
  for (const m of methods) {
    const row = { id: String(m.id ?? m.shipping_method), shippingMethod: m.shipping_method, carrier: m.carrier ?? '', scac: m.scac ?? '', serviceCode: m.service_code ?? '', raw: m };
    await db.insert(schema.shippingMethods).values(row).onConflictDoUpdate({ target: schema.shippingMethods.id, set: row });
  }
  return { distributionCenters: dcList.length, shippingMethods: methods.length };
}

/** Summary used by the Taxonomy page and the Test Plan (4.2 - 5.1). */
export async function itemTypeSummary(itemTypeId: string) {
  const attrs = await db.select().from(schema.attributes).where(eq(schema.attributes.itemTypeId, itemTypeId));
  const content = attrs.filter((a) => a.group !== 'LOGISTICS');
  const byType: Record<string, number> = {};
  for (const a of attrs) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const bullets = attrs.filter((a) => /^descriptions\.bullets\[\d+\]$/.test(a.mappedProperty ?? '')).length;
  return {
    total: attrs.length,
    required: attrs.filter((a) => a.required).length,
    optional: attrs.filter((a) => !a.required).length,
    contentAttributes: content.length,
    logisticsAttributes: attrs.length - content.length,
    byType,
    bullets,
  };
}

// ---------------------------------------------------------------- Attributes & Values file (portal / BULK_PRODUCT_DATA_TEMPLATE)
const META_KEYS = new Set(['external_id', 'parent_sku', 'relationship_type', 'action']);
const UNITS = /^(inches|inch|in|pounds|pound|lb|lbs|ounces|ounce|oz|feet|foot|ft|centimeters|cm|millimeters|mm|grams|g|kilograms|kg|liters|milliliters|ml|fluid ounces|count|each)$/i;
const cellStr = (v: any): string => String(v?.richText ? v.richText.map((x: any) => x.text).join('') : v?.text ?? v?.result ?? v ?? '').trim();
const cleanName = (s: string) => s.replace(/\*+\s*$/, '').trim();

/**
 * Read Target's "Attributes And Values" / BULK_PRODUCT_DATA_TEMPLATE Excel for one item type:
 * sheet 1 row 1 = attribute names, row 2 = keys (mapped_property / attribute id);
 * the item type sheet: row 1 = names (* = required), row 2 = notes (max selections), row 3+ = allowed values / TEXT / unit.
 */
export async function importAttributeFile(buf: Buffer, opts: { itemTypeId?: string; itemTypeName?: string } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheets = wb.worksheets;
  const rowVals = (ws: ExcelJS.Worksheet, n: number) => { const out: string[] = []; ws.getRow(n).eachCell({ includeEmpty: true }, (c, i) => { out[i - 1] = cellStr(c.value); }); return Array.from(out, (x) => x ?? ''); };
  // sheet with the keys row ("external_id" in row 2)
  const keySheet = sheets.find((ws) => rowVals(ws, 2).includes('external_id') || rowVals(ws, 1).includes('external_id'));
  if (!keySheet) throw Object.assign(new Error('This file has no row with the Target keys (external_id, brands.name, …). Use the "Attributes And Values" or "Bulk Product Data Template" Excel from the Target portal.'), { statusCode: 400 });
  const keyRowNo = rowVals(keySheet, 2).includes('external_id') ? 2 : 1;
  const names = keyRowNo === 2 ? rowVals(keySheet, 1) : [];
  const keys = rowVals(keySheet, keyRowNo);
  const valueSheet = sheets.find((ws) => ws !== keySheet && ws.rowCount > 2);
  const itemTypeName = (opts.itemTypeName || valueSheet?.name || '').trim();
  if (!itemTypeName) throw Object.assign(new Error('Could not tell which item type this file is for. Type the item type name.'), { statusCode: 400 });

  // value sheet: name -> { required, max, values[] }
  const info = new Map<string, { required: boolean; max: number; values: string[] }>();
  if (valueSheet) {
    const vNames = rowVals(valueSheet, 1);
    const notes = rowVals(valueSheet, 2);
    vNames.forEach((raw, i) => {
      if (!raw) return;
      const values: string[] = [];
      for (let r = 3; r <= valueSheet.rowCount; r++) {
        const v = cellStr(valueSheet.getRow(r).getCell(i + 1).value);
        if (v && !/^attribute type formats|^text based attributes|^measure attributes|^value based|^number/i.test(v)) values.push(v);
      }
      const max = Number(notes[i]?.match(/max selections\s*(\d+)/i)?.[1] ?? 1) || 1;
      info.set(cleanName(raw).toLowerCase(), { required: /\*\s*$/.test(raw), max, values: [...new Set(values)] });
    });
  }
  // reuse an item type already added with the same name (e.g. found by search) so products keep their category
  const existing = (await db.select().from(schema.itemTypes)).find((t) => t.name.trim().toLowerCase() === itemTypeName.toLowerCase());
  const id = (opts.itemTypeId || '').trim() || existing?.id || `file:${itemTypeName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  await saveItemTypes([{ id, name: itemTypeName }]);
  let attrs = 0, withValues = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key || META_KEYS.has(key)) continue;
    const name = cleanName(names[i] || key);
    const inf = info.get(name.toLowerCase());
    const vals = inf?.values ?? [];
    let type = 'TEXT';
    if (vals.length === 1 && /^(TEXT|NUMBER|INTEGER)$/i.test(vals[0])) type = vals[0].toUpperCase();
    else if (vals.length === 1 && UNITS.test(vals[0])) type = 'MEASURE';
    else if (vals.length >= 1) type = 'VALUE';
    else if (/^package_dimensions\./.test(key)) type = 'MEASURE';
    const group = /^compliance\.tax/.test(key) ? 'TAX' : /^fulfillment\.|^shipping_exclusion|^seller_return_policy/.test(key) ? 'LOGISTICS' : key.includes('.') || key.includes('[') || key.startsWith('variation') ? 'CORE' : 'SELLING';
    const row = {
      itemTypeId: id, attributeId: key, taxonomyId: key.includes('.') ? 'root' : id, name, mappedProperty: key.includes('.') || key.includes('[') || key.includes('_') ? key : null,
      type, group, required: !!inf?.required, maxSelections: inf?.max ?? 1, description: null, raw: { source: 'file' }, valuesFetched: true,
    };
    const [saved] = await db.insert(schema.attributes).values(row).onConflictDoUpdate({ target: [schema.attributes.itemTypeId, schema.attributes.attributeId], set: row }).returning({ id: schema.attributes.id });
    attrs++;
    await db.delete(schema.attributeValues).where(eq(schema.attributeValues.attrId, saved.id));
    const list = type === 'VALUE' || type === 'MEASURE' ? vals : [];
    if (list.length) {
      withValues++;
      const rows = list.map((v, n) => ({ attrId: saved.id, valueId: `${n}:${v}`.slice(0, 200), name: v }));
      for (let k = 0; k < rows.length; k += 500) await db.insert(schema.attributeValues).values(rows.slice(k, k + 500)).onConflictDoNothing();
    }
  }
  await db.update(schema.itemTypes).set({ attributesFetchedAt: new Date(), valuesFetchedAt: new Date() }).where(eq(schema.itemTypes.id, id));
  return { itemTypeId: id, itemTypeName, attributes: attrs, valueLists: withValues };
}

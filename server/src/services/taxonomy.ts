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

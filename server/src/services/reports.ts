// Report requests: create, track, download (stage needs the tgtrt header), cancel.
import { desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as T from '../target/api.js';
import ExcelJS from 'exceljs';
import { parseAllowedItemTypes, parseCsv, saveItemTypes } from './taxonomy.js';

async function store(r: any, params?: any) {
  const row = { id: String(r.id), type: r.type, format: r.format ?? null, status: r.status ?? 'PENDING', downloadUrl: r.download_url ?? null, raw: r, ...(params ? { params } : {}) };
  await db.insert(schema.reportRequests).values(row).onConflictDoUpdate({ target: schema.reportRequests.id, set: row });
  return row;
}

export async function requestReport(body: { type: string; format?: string; start_date?: string; end_date?: string; parameters?: Record<string, any> }) {
  const r = await T.createReport(body);
  return store(r, body);
}

export async function refreshReport(id: string) {
  return store(await T.getReport(id));
}

/** Refresh all reports that are not finished yet. */
export async function refreshOpenReports() {
  const open = await db.select().from(schema.reportRequests).where(inArray(schema.reportRequests.status, ['PENDING', 'PROCESSING']));
  for (const r of open) { try { await refreshReport(r.id); } catch { /* ignore */ } }
  return open.length;
}

/** Import reports created elsewhere (portal / Insomnia). */
export async function syncReportList() {
  const list = await T.listReports({ per_page: 100 });
  const arr = Array.isArray(list) ? list : list?.data ?? [];
  for (const r of arr) await store(r);
  return arr.length;
}

export async function cancel(id: string) {
  await T.cancelReport(id);
  return refreshReport(id);
}

export async function download(id: string) {
  const r = await db.query.reportRequests.findFirst({ where: eq(schema.reportRequests.id, id) });
  if (!r?.downloadUrl) throw new Error('Report has no download_url yet (status must be COMPLETE)');
  return T.downloadReport(r.downloadUrl);
}

/** ALLOWED_ITEM_TYPES: download and save item types. */
export async function importAllowedItemTypes(id?: string) {
  const r = id
    ? await db.query.reportRequests.findFirst({ where: eq(schema.reportRequests.id, id) })
    : (await db.select().from(schema.reportRequests).where(eq(schema.reportRequests.type, 'ALLOWED_ITEM_TYPES')).orderBy(desc(schema.reportRequests.createdAt)).limit(5)).find((x) => x.status === 'COMPLETE');
  if (!r) throw new Error('No completed ALLOWED_ITEM_TYPES report. Request one and wait until it is COMPLETE.');
  const { data, contentType } = await download(r.id);
  const types = await parseAllowedItemTypes(data, contentType);
  if (!types.length) {
    const sample = typeof data === 'string' ? data : Buffer.isBuffer(data) ? `(binary file, ${data.length} bytes, ${contentType})` : JSON.stringify(data);
    throw new Error(`Could not find item types in the report. Start of the report: ${String(sample).slice(0, 300)}`);
  }
  await saveItemTypes(types);
  return { count: types.length, types: types.slice(0, 50).map((t) => ({ id: t.id, name: t.name })) };
}

// ---------- view a report inside the hub ----------
const cellText = (v: any): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('');
    return JSON.stringify(v);
  }
  return String(v);
};

/** An error object as plain words: "CRITICAL · brands.name · Brand … not approved". */
const readable = (x: any): string => x == null ? '' : typeof x !== 'object' ? String(x)
  : Array.isArray(x) ? x.map(readable).join(', ')
  : Object.values(x).filter((v) => v != null && v !== '').map((v) => (typeof v === 'object' ? readable(v) : String(v))).join(' · ');

/** Flatten nested JSON rows one level so they show as columns ({a:{b:1}} -> "a.b"). */
function flatten(row: any, prefix = '', out: Record<string, any> = {}, depth = 0) {
  if (row == null || typeof row !== 'object' || Array.isArray(row) || depth > 2) { out[prefix || 'value'] = Array.isArray(row) ? JSON.stringify(row) : row; return out; }
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, depth + 1);
    else out[key] = Array.isArray(v) ? v.map(readable).join(' | ') : v;
  }
  return out;
}

async function excelRows(buf: Buffer): Promise<Record<string, any>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  // the sheet with the most rows is the data sheet
  const ws = [...wb.worksheets].sort((a, b) => b.actualRowCount - a.actualRowCount)[0];
  if (!ws) return [];
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => { const vals = (r.values as any[]).slice(1).map(cellText); grid.push(vals); });
  // header = first row (of the first 15) with the most filled cells; title rows above it are skipped
  let h = 0, best = -1;
  for (let i = 0; i < Math.min(15, grid.length); i++) { const n = grid[i].filter((x) => x.trim()).length; if (n > best) { best = n; h = i; } }
  const head = grid[h].map((x, i) => x.trim() || `col${i + 1}`);
  return grid.slice(h + 1).filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

const SKU_COLS = /^(external_id|sku|partner_sku|seller_sku|item_external_id|product_external_id|external id|sku id|partner sku)$/i;

/** A downloaded report as a table: columns, rows, which column is the SKU, and the hub product for each SKU. */
export async function reportTable(id: string, opts: { q?: string; limit?: number } = {}) {
  const r = await db.query.reportRequests.findFirst({ where: eq(schema.reportRequests.id, id) });
  const { data, contentType } = await download(id);
  let rows: any[] = [];
  if (Buffer.isBuffer(data)) {
    if (/sheet|excel|zip/.test(contentType) || data.subarray(0, 2).toString() === 'PK') rows = await excelRows(data);
    else rows = parseCsv(data.toString('utf8'));
  } else if (Array.isArray(data)) rows = data;
  else if (typeof data === 'string') rows = /^\s*[\[{]/.test(data) ? [].concat(JSON.parse(data)) : parseCsv(data);
  else if (data && typeof data === 'object') {
    const d: any = data;
    rows = Array.isArray(d.data) ? d.data : Array.isArray(d.items) ? d.items : Array.isArray(d.results) ? d.results : [d];
  }
  rows = rows.map((x) => flatten(x));
  const columns: string[] = [];
  for (const row of rows.slice(0, 500)) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const skuCol = columns.find((c) => SKU_COLS.test(c.trim())) ?? columns.find((c) => /external_id|sku/i.test(c)) ?? null;
  const total = rows.length;
  if (opts.q) { const q = opts.q.toLowerCase(); rows = rows.filter((x) => Object.values(x).some((v) => String(v ?? '').toLowerCase().includes(q))); }
  const matched = rows.length;
  rows = rows.slice(0, opts.limit ?? 2000);
  const products: Record<string, string> = {};
  if (skuCol) {
    const skus = [...new Set(rows.map((x) => String(x[skuCol] ?? '')).filter(Boolean))];
    if (skus.length) {
      const vs = await db.select({ sku: schema.variants.sku, productId: schema.variants.productId }).from(schema.variants).where(inArray(schema.variants.sku, skus));
      const ps = await db.select({ sku: schema.products.parentExternalId, productId: schema.products.id }).from(schema.products).where(inArray(schema.products.parentExternalId, skus));
      for (const x of [...vs, ...ps]) if (x.sku) products[x.sku] = x.productId;
    }
  }
  return { id, type: r?.type, format: r?.format, createdAt: r?.createdAt, total, matched, columns, skuCol, rows, products };
}

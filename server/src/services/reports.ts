// Report requests: create, track, download (stage needs the tgtrt header), cancel.
import { desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as T from '../target/api.js';
import { parseAllowedItemTypes, saveItemTypes } from './taxonomy.js';

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

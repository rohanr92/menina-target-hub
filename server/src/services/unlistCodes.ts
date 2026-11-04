// Bulk unlist by TCIN or barcode (paste a column from Excel). Check first, then unlist in the background.
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getActiveEnv } from '../lib/settings.js';
import { relistTargetProduct, unlistTargetProduct } from './items.js';
import { normBarcode } from './targetCatalog.js';

export interface UnlistRow {
  targetId: string; tcin: string | null; barcode: string | null; sku: string | null; title: string | null;
  status: string | null; variantId: string | null; productId: string | null; codes: string[]; viaParent?: string;
}

/** Every number of 8–14 digits in the text is a TCIN or a barcode (UPC/EAN, leading zeros ignored). */
export async function matchCodes(text: string) {
  const codes = [...new Set((String(text ?? '').match(/\d{6,14}/g) ?? []))];
  const env = await getActiveEnv();
  const items = await db.select().from(schema.targetItems).where(eq(schema.targetItems.env, env));
  const vs = await db.select().from(schema.variants);
  const byTcin = new Map<string, typeof items>(), byBar = new Map<string, typeof items>(), children = new Map<string, typeof items>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const t of items) {
    if (t.tcin) push(byTcin, String(t.tcin), t);
    if (t.barcode) push(byBar, normBarcode(t.barcode), t);
    if (t.parentId) push(children, String(t.parentId), t);
  }
  const vByTarget = new Map(vs.filter((v) => v.targetProductId).map((v) => [v.targetProductId!, v]));
  const vByTcin = new Map(vs.filter((v) => v.tcin).map((v) => [String(v.tcin), v]));
  const vByBar = new Map(vs.filter((v) => v.barcode).map((v) => [normBarcode(v.barcode), v]));

  const rows = new Map<string, UnlistRow>();
  const notFound: string[] = [];
  const add = (targetId: string, code: string, t?: typeof items[number] | null, viaParent?: string) => {
    const v = vByTarget.get(targetId) ?? null;
    const r = rows.get(targetId) ?? {
      targetId, tcin: t?.tcin ?? v?.tcin ?? null, barcode: t?.barcode ?? v?.barcode ?? null, sku: v?.sku ?? t?.externalId ?? null,
      title: t?.title ?? null, status: v?.listingStatus ?? t?.listingStatus ?? null, variantId: v?.id ?? null, productId: v?.productId ?? null, codes: [], viaParent,
    };
    if (!r.codes.includes(code)) r.codes.push(code);
    rows.set(targetId, r);
  };
  for (const code of codes) {
    const hits = [...(byTcin.get(code) ?? []), ...(byBar.get(normBarcode(code)) ?? [])];
    let found = false;
    for (const t of hits) {
      found = true;
      // a parent TCIN means all of its sizes
      if (t.relationshipType === 'VAP') { for (const c of children.get(t.id) ?? []) add(c.id, code, c, t.tcin ?? t.id); }
      else add(t.id, code, t);
    }
    if (!found) {
      const v = vByTcin.get(code) ?? vByBar.get(normBarcode(code));
      if (v?.targetProductId) { add(v.targetProductId, code, null); found = true; }
    }
    if (!found) notFound.push(code);
  }
  const list = [...rows.values()];
  return {
    codes: codes.length, items: list, notFound,
    counts: { toUnlist: list.filter((r) => r.status !== 'UNLISTED').length, toRelist: list.filter((r) => r.status === 'UNLISTED').length, alreadyUnlisted: list.filter((r) => r.status === 'UNLISTED').length, inHub: list.filter((r) => r.variantId).length },
  };
}

export const unlistJob: { action: 'unlist' | 'relist'; running: boolean; total: number; done: number; startedAt: string | null; finishedAt: string | null; results: any[] } = {
  action: 'unlist', running: false, total: 0, done: 0, startedAt: null, finishedAt: null, results: [],
};

/** Unlist every matched item (in the background). Each one: Send OFF → unlist the live version → Target confirms. */
export async function startUnlistCodes(text: string, action: 'unlist' | 'relist' = 'unlist') {
  if (unlistJob.running) throw Object.assign(new Error(`An ${unlistJob.action} is already running`), { statusCode: 409 });
  const m = await matchCodes(text);
  if (!m.items.length) throw Object.assign(new Error('No Target items found for these codes'), { statusCode: 400 });
  Object.assign(unlistJob, { action, running: true, total: m.items.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null, results: [] });
  (async () => {
    for (const r of m.items) {
      const base = { sku: r.sku, tcin: r.tcin, barcode: r.barcode, title: r.title, codes: r.codes };
      try {
        const x = action === 'relist' ? await relistTargetProduct(r.targetId, r.variantId) : await unlistTargetProduct(r.targetId, r.variantId);
        unlistJob.results.push({ ...base, ok: true, result: x.status, detail: x.detail });
      } catch (e: any) {
        unlistJob.results.push({ ...base, ok: false, result: 'failed', detail: e?.message ?? String(e) });
      }
      unlistJob.done++;
    }
    unlistJob.running = false;
    unlistJob.finishedAt = new Date().toISOString();
  })().catch(() => { unlistJob.running = false; unlistJob.finishedAt = new Date().toISOString(); });
  return { started: true, total: m.items.length, notFound: m.notFound };
}

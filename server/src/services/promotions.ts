// Marketplace portal › Promotions
//  - Target's PROMOTIONS report (read every day): the promotions Target lists for this seller
//  - promotions you add by hand (the open ones you see in the Partner Portal), with SKUs and a discount:
//    the hub puts the promo price on Target on the start date and restores the normal price on the end date
//  - alerts before opt-in deadlines
import { inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting, setSetting } from '../lib/settings.js';
import * as T from '../target/api.js';
import { normBarcode } from './targetCatalog.js';
import { enqueue } from './sync.js';

export type Promo = {
  id: number; source: 'target' | 'manual'; target_key: string | null; name: string; category: string | null;
  start_at: string | null; end_at: string | null; deadline_at: string | null; status: string;
  discount_type: 'percent' | 'fixed' | null; discount_value: number | null; variant_ids: string[]; notes: string | null;
  applied_at: string | null; restored_at: string | null; raw: any;
};
const STATUSES = ['planned', 'joined', 'skipped'];
const bad = (m: string) => Object.assign(new Error(m), { statusCode: 400 });
const dt = (x: any) => { if (!x) return null; const d = new Date(x); return isNaN(+d) ? null : d.toISOString(); };

export async function listPromotions() {
  const r = await db.execute(sql`SELECT * FROM promotions ORDER BY coalesce(start_at, deadline_at, created_at) DESC`);
  const promos = r.rows as any[];
  // SKU details for the list
  const ids = [...new Set(promos.flatMap((p) => p.variant_ids ?? []))];
  const vs = ids.length ? await db.select({ id: schema.variants.id, sku: schema.variants.sku, productId: schema.variants.productId, listingStatus: schema.variants.listingStatus }).from(schema.variants).where(inArray(schema.variants.id, ids)) : [];
  const byId = new Map(vs.map((v) => [v.id, v]));
  const settings = await getSetting<any>('promotions', {});
  return {
    portalUrl: settings.portalUrl ?? 'https://plus.target.com/',
    lastTargetSync: settings.lastTargetSync ?? null,
    promotions: promos.map((p) => ({ ...p, discount_value: p.discount_value == null ? null : Number(p.discount_value), skus: (p.variant_ids ?? []).map((id: string) => byId.get(id)?.sku).filter(Boolean) })),
  };
}

/** SKUs, TCINs or barcodes (any mix, one per line) → hub variant ids. */
async function variantIdsFromCodes(text: string) {
  const codes = [...new Set(String(text ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
  if (!codes.length) return { ids: [] as string[], notFound: [] as string[] };
  const vs = await db.select({ id: schema.variants.id, sku: schema.variants.sku, tcin: schema.variants.tcin, barcode: schema.variants.barcode }).from(schema.variants);
  const ids = new Set<string>(); const notFound: string[] = [];
  for (const c of codes) {
    const hit = vs.filter((v) => v.sku === c || (v.tcin && String(v.tcin) === c) || (/^\d{8,14}$/.test(c) && v.barcode && normBarcode(v.barcode) === normBarcode(c)));
    if (hit.length) hit.forEach((h) => ids.add(h.id)); else notFound.push(c);
  }
  return { ids: [...ids], notFound };
}

export async function savePromotion(body: any, id?: number) {
  const name = String(body.name ?? '').trim();
  if (!name) throw bad('Name is required');
  const status = STATUSES.includes(body.status) ? body.status : 'planned';
  const type = body.discount_type === 'percent' || body.discount_type === 'fixed' ? body.discount_type : null;
  const value = body.discount_value === '' || body.discount_value == null ? null : Number(body.discount_value);
  if (type === 'percent' && !(value! > 0 && value! < 90)) throw bad('Percent off must be between 1 and 89');
  if (type === 'fixed' && !(value! > 0)) throw bad('Promo price must be more than 0');
  const start = dt(body.start_at), end = dt(body.end_at), deadline = dt(body.deadline_at);
  if (start && end && end <= start) throw bad('End must be after start');
  const { ids, notFound } = await variantIdsFromCodes(body.codes ?? '');
  const json = JSON.stringify(ids);
  let row: any;
  if (id) {
    const before = (await db.execute(sql`SELECT * FROM promotions WHERE id = ${id}`)).rows[0] as any;
    if (!before) throw Object.assign(new Error('Promotion not found'), { statusCode: 404 });
    row = (await db.execute(sql`UPDATE promotions SET name = ${name}, category = ${body.category || null}, start_at = ${start}, end_at = ${end}, deadline_at = ${deadline},
      status = ${status}, discount_type = ${type}, discount_value = ${value}, variant_ids = ${json}::jsonb, notes = ${body.notes || null}, updated_at = now() WHERE id = ${id} RETURNING *`)).rows[0];
    // SKUs taken out of a running promo get their normal price back
    const removed = (before.variant_ids ?? []).filter((v: string) => !ids.includes(v));
    if (removed.length) await clearPromo(id, removed);
  } else {
    row = (await db.execute(sql`INSERT INTO promotions (source, name, category, start_at, end_at, deadline_at, status, discount_type, discount_value, variant_ids, notes)
      VALUES ('manual', ${name}, ${body.category || null}, ${start}, ${end}, ${deadline}, ${status}, ${type}, ${value}, ${json}::jsonb, ${body.notes || null}) RETURNING *`)).rows[0];
  }
  const applied = await applyPromotions();
  return { promotion: row, skus: ids.length, notFound, applied };
}

export async function deletePromotion(id: number) {
  await clearPromo(id);
  await db.execute(sql`DELETE FROM promotions WHERE id = ${id}`);
  return { deleted: true };
}

/** Remove a promo price from SKUs (all of the promo's SKUs, or only the given ones) and send the normal price. */
async function clearPromo(promoId: number, onlyIds?: string[]) {
  const vs = await db.select().from(schema.variants).where(sql`overrides->'_promo'->>'id' = ${String(promoId)}`);
  let n = 0;
  for (const v of vs) {
    if (onlyIds && !onlyIds.includes(v.id)) continue;
    const o = { ...((v.overrides as any) ?? {}) }; delete o._promo;
    await db.update(schema.variants).set({ overrides: o }).where(sql`id = ${v.id}`);
    await enqueue('price', v.id, { force: true }); n++;
  }
  return n;
}

/**
 * Runs every few minutes: promotions you JOINED that have SKUs and a discount get the promo price on Target
 * while they run (start → end), and the normal price back afterwards. Skipped / deleted promos are restored.
 */
export async function applyPromotions() {
  const now = new Date();
  const promos = (await db.execute(sql`SELECT * FROM promotions WHERE source = 'manual'`)).rows as any[];
  let started = 0, ended = 0;
  for (const p of promos) {
    const ids: string[] = p.variant_ids ?? [];
    const running = p.status === 'joined' && p.discount_type && p.discount_value != null && ids.length
      && (!p.start_at || new Date(p.start_at) <= now) && p.end_at && new Date(p.end_at) > now;
    if (running) {
      const promo = { id: String(p.id), type: p.discount_type, value: Number(p.discount_value), end: new Date(p.end_at).toISOString(), name: p.name };
      const vs = await db.select().from(schema.variants).where(inArray(schema.variants.id, ids));
      for (const v of vs) {
        const cur = (v.overrides as any)?._promo;
        if (cur && JSON.stringify(cur) === JSON.stringify(promo)) continue;
        await db.update(schema.variants).set({ overrides: { ...((v.overrides as any) ?? {}), _promo: promo } }).where(sql`id = ${v.id}`);
        await enqueue('price', v.id, { force: true }); started++;
      }
      if (!p.applied_at) await db.execute(sql`UPDATE promotions SET applied_at = now(), restored_at = NULL WHERE id = ${p.id}`);
    } else {
      const n = await clearPromo(p.id);
      if (n) { ended += n; await db.execute(sql`UPDATE promotions SET restored_at = now() WHERE id = ${p.id}`); }
    }
  }
  return { started, ended };
}

/** Alerts: opt-in deadline within 3 days for promotions you haven't decided on; joined promos missing SKUs or a discount. */
export async function promotionAlerts() {
  const { raise, resolve } = await import('./alerts.js');
  const promos = (await db.execute(sql`SELECT * FROM promotions WHERE source = 'manual'`)).rows as any[];
  const now = Date.now();
  for (const p of promos) {
    const ref = `promo-${p.id}`;
    const dl = p.deadline_at ? new Date(p.deadline_at).getTime() : null;
    if (p.status === 'planned' && dl && dl > now && dl - now < 3 * 864e5) {
      const days = Math.max(0, Math.round((dl - now) / 864e5));
      await raise({ kind: 'promo-deadline', severity: days <= 1 ? 'critical' : 'warning', ref, title: `Promotion deadline ${days ? `in ${days} day(s)` : 'today'}: ${p.name}`, detail: 'Join it in the Target Partner Portal, then mark it Joined in the hub.', link: '/marketplace' });
    } else await resolve('promo-deadline', ref);
    const st = p.start_at ? new Date(p.start_at).getTime() : null;
    if (p.status === 'joined' && st && st > now && st - now < 2 * 864e5 && (!(p.variant_ids ?? []).length || !p.discount_type)) {
      await raise({ kind: 'promo-setup', severity: 'warning', ref, title: `Promotion starts soon without ${!(p.variant_ids ?? []).length ? 'SKUs' : 'a discount'}: ${p.name}`, detail: 'Add the SKUs and the discount so the hub sends the promo price.', link: '/marketplace' });
    } else await resolve('promo-setup', ref);
  }
  return { checked: promos.length };
}

/** Target's PROMOTIONS report → promotions list (source "target"). Unknown fields are kept and shown as they are. */
export async function syncTargetPromotions() {
  const now = Date.now();
  const req = await T.createReport({ type: 'PROMOTIONS', format: 'JSON', start_date: new Date(now - 180 * 864e5).toISOString(), end_date: new Date(now + 365 * 864e5).toISOString() }, 'promotions');
  let rep: any = req;
  for (let i = 0; i < 24 && !['COMPLETE', 'ERROR', 'FAILED', 'CANCELLED'].includes(rep?.status); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    rep = await T.getReport(req.id);
  }
  if (rep?.status !== 'COMPLETE' || !rep.download_url) throw new Error(`Target promotions report ${rep?.status ?? 'unknown'}${rep?.feedback?.length ? `: ${JSON.stringify(rep.feedback).slice(0, 200)}` : ''}`);
  const dl = await T.downloadReport(rep.download_url);
  const data = typeof dl.data === 'string' ? JSON.parse(dl.data) : dl.data;
  const list: any[] = data?.sections?.promotions ?? data?.promotions ?? (Array.isArray(data) ? data : []);
  const pick = (o: any, keys: string[]) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return null; };
  let n = 0;
  for (const p of list) {
    const key = String(pick(p, ['id', 'promotion_id', 'promo_id', 'event_id']) ?? JSON.stringify(p).slice(0, 200));
    const name = String(pick(p, ['name', 'promotion_name', 'title', 'event_name', 'description']) ?? 'Target promotion');
    const start = dt(pick(p, ['start_date', 'start_time', 'start', 'begin_date', 'effective_date']));
    const end = dt(pick(p, ['end_date', 'end_time', 'end', 'expiration_date']));
    const deadline = dt(pick(p, ['opt_in_deadline', 'deadline', 'registration_end_date', 'submission_deadline', 'enrollment_end_date']));
    const category = pick(p, ['category', 'promotion_type', 'type', 'event_type', 'department']);
    await db.execute(sql`INSERT INTO promotions (source, target_key, name, category, start_at, end_at, deadline_at, status, raw)
      VALUES ('target', ${key}, ${name}, ${category ? String(category) : null}, ${start}, ${end}, ${deadline}, 'joined', ${JSON.stringify(p)}::jsonb)
      ON CONFLICT (target_key) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
        deadline_at = EXCLUDED.deadline_at, raw = EXCLUDED.raw, updated_at = now()`);
    n++;
  }
  const cur = await getSetting<any>('promotions', {});
  await setSetting('promotions', { ...cur, lastTargetSync: { at: new Date().toISOString(), count: n, reportId: req.id } });
  return { fromTarget: n };
}

export async function setPortalUrl(url: string) {
  const u = String(url ?? '').trim();
  if (u && !/^https:\/\//.test(u)) throw bad('Use a full https:// link');
  const cur = await getSetting<any>('promotions', {});
  await setSetting('promotions', { ...cur, portalUrl: u || 'https://plus.target.com/' });
  return { ok: true };
}

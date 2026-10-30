import type { FastifyInstance } from 'fastify';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { audit, dailySummary, getAlertSettings, postSlack } from '../services/alerts.js';
import { enqueue } from '../services/sync.js';
import * as T from '../target/api.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
const rows = async (q: any) => (await db.execute(q)).rows as any[];

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `s1.${salt.toString('base64url')}.${scryptSync(pw, salt, 32).toString('base64url')}`;
}
export function checkPassword(pw: string, stored: string) {
  const [v, s, h] = stored.split('.');
  if (v !== 's1') return false;
  const a = scryptSync(pw, Buffer.from(s, 'base64url'), 32), b = Buffer.from(h, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const actorOf = (req: any): { id: number | null; name: string; role: string } => req.actor ?? { id: null, name: 'admin', role: 'admin' };
const needAdmin = (req: any) => { if (actorOf(req).role !== 'admin') throw bad('Only admins can do this', 403); };

export default async function (app: FastifyInstance) {
  // ---------------- users ----------------
  app.get('/api/users', async (req) => { needAdmin(req); return rows(sql`SELECT id, email, name, role, active, created_at, last_login_at FROM users ORDER BY id`); });
  app.post('/api/users', async (req) => {
    needAdmin(req);
    const b = req.body as any;
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
    if (String(b.password ?? '').length < 10) throw bad('Password must be at least 10 characters');
    const role = b.role === 'admin' ? 'admin' : 'staff';
    const ex = await rows(sql`SELECT id FROM users WHERE email = ${email}`);
    if (ex.length) throw bad('A user with this email already exists');
    await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${b.name ?? null}, ${hashPassword(String(b.password))}, ${role})`);
    return { ok: true };
  });
  app.patch('/api/users/:id', async (req) => {
    needAdmin(req);
    const id = Number((req.params as any).id); const b = req.body as any;
    if (b.password !== undefined) { if (String(b.password).length < 10) throw bad('Password must be at least 10 characters'); await db.execute(sql`UPDATE users SET password_hash = ${hashPassword(String(b.password))} WHERE id = ${id}`); }
    if (b.role !== undefined) await db.execute(sql`UPDATE users SET role = ${b.role === 'admin' ? 'admin' : 'staff'} WHERE id = ${id}`);
    if (b.active !== undefined) await db.execute(sql`UPDATE users SET active = ${!!b.active} WHERE id = ${id}`);
    if (b.name !== undefined) await db.execute(sql`UPDATE users SET name = ${b.name} WHERE id = ${id}`);
    return { ok: true };
  });
  app.post('/api/me/password', async (req) => {
    const a = actorOf(req); const b = req.body as any;
    if (!a.id) throw bad('Sign in with your own user (email) to change your password');
    const u = (await rows(sql`SELECT password_hash FROM users WHERE id = ${a.id}`))[0];
    if (!u || !checkPassword(String(b.current ?? ''), u.password_hash)) throw bad('Current password is wrong');
    if (String(b.password ?? '').length < 10) throw bad('New password must be at least 10 characters');
    await db.execute(sql`UPDATE users SET password_hash = ${hashPassword(String(b.password))} WHERE id = ${a.id}`);
    return { ok: true };
  });

  // ---------------- alerts ----------------
  app.get('/api/alerts', async (req) => {
    const all = (req.query as any)?.all === '1';
    const list = await rows(all ? sql`SELECT * FROM alerts ORDER BY at DESC LIMIT 200` : sql`SELECT * FROM alerts WHERE resolved = false ORDER BY at DESC LIMIT 100`);
    const c = (await rows(sql`SELECT count(*) FILTER (WHERE resolved = false)::int AS open, count(*) FILTER (WHERE resolved = false AND seen = false)::int AS unseen, count(*) FILTER (WHERE resolved = false AND severity = 'critical')::int AS critical FROM alerts`))[0];
    return { ...c, alerts: list };
  });
  app.post('/api/alerts/seen', async () => { await db.execute(sql`UPDATE alerts SET seen = true WHERE seen = false`); return { ok: true }; });
  app.post('/api/alerts/:id/resolve', async (req) => { await db.execute(sql`UPDATE alerts SET resolved = true WHERE id = ${Number((req.params as any).id)}`); return { ok: true }; });
  app.post('/api/alerts/resolve-all', async () => { await db.execute(sql`UPDATE alerts SET resolved = true WHERE resolved = false`); return { ok: true }; });
  app.get('/api/settings/alerts', async () => { const s = await getAlertSettings(); return { ...s, slackWebhookUrl: undefined, hasSlack: !!s.slackWebhookUrl }; });
  app.put('/api/settings/alerts', async (req) => {
    needAdmin(req);
    const b = req.body as any; const cur = await getAlertSettings();
    const next = { ...cur,
      ...(b.slackWebhookUrl !== undefined && b.slackWebhookUrl !== '__keep__' ? { slackWebhookUrl: String(b.slackWebhookUrl).trim() || undefined } : {}),
      ...(b.slackMinSeverity ? { slackMinSeverity: b.slackMinSeverity } : {}),
      ...(b.dailySummaryHourUtc !== undefined ? { dailySummaryHourUtc: b.dailySummaryHourUtc === null || b.dailySummaryHourUtc === '' ? null : Math.max(0, Math.min(23, Number(b.dailySummaryHourUtc))) } : {}),
    };
    if (next.slackWebhookUrl && !/^https:\/\/hooks\.slack\.com\//.test(next.slackWebhookUrl)) throw bad('Slack webhook URLs start with https://hooks.slack.com/');
    await setSetting('alerts', next);
    return { ok: true };
  });
  app.post('/api/alerts/test', async () => ({ sent: await postSlack(':white_check_mark: Target Hub alerts are connected to this channel.') }));
  app.post('/api/alerts/summary-now', async () => dailySummary());

  // ---------------- price holds ----------------
  app.get('/api/price-holds', async () => rows(sql`SELECT h.*, v.product_id, v.options, v.price AS shopify_price, v.compare_at_price, p.title FROM price_holds h
    LEFT JOIN variants v ON v.id = h.variant_id LEFT JOIN products p ON p.id = v.product_id WHERE h.status = 'held' ORDER BY h.created_at DESC LIMIT 500`));
  const decide = async (req: any, ok: boolean) => {
    const ids: number[] = ((req.body as any)?.ids ?? [Number(req.params.id)]).map(Number).filter(Boolean);
    const who = actorOf(req).name;
    for (const id of ids) {
      const h = (await rows(sql`SELECT * FROM price_holds WHERE id = ${id} AND status = 'held'`))[0];
      if (!h) continue;
      await db.execute(sql`UPDATE price_holds SET status = ${ok ? 'approved' : 'rejected'}, decided_at = now(), decided_by = ${who} WHERE id = ${id}`);
      if (ok) {
        await db.execute(sql`UPDATE variants SET overrides = overrides || jsonb_build_object('_price_ok', ${JSON.stringify(h.proposed)}::text) WHERE id = ${h.variant_id}`);
        await enqueue('price', h.variant_id, { force: true });
      }
      await db.execute(sql`UPDATE alerts SET resolved = true WHERE kind = 'price-hold' AND ref = ${h.variant_id}`);
    }
    return { updated: ids.length };
  };
  app.post('/api/price-holds/:id/approve', async (req) => decide(req, true));
  app.post('/api/price-holds/:id/reject', async (req) => decide(req, false));
  app.post('/api/price-holds/approve', async (req) => decide(req, true));
  app.post('/api/price-holds/reject', async (req) => decide(req, false));

  // ---------------- activity log ----------------
  app.get('/api/audit', async (req) => {
    const { q, limit } = req.query as any;
    const n = Math.min(1000, Number(limit) || 300);
    return q ? rows(sql`SELECT * FROM audit_log WHERE actor ILIKE ${'%' + q + '%'} OR action ILIKE ${'%' + q + '%'} OR target ILIKE ${'%' + q + '%'} OR detail::text ILIKE ${'%' + q + '%'} ORDER BY at DESC LIMIT ${n}`)
      : rows(sql`SELECT * FROM audit_log ORDER BY at DESC LIMIT ${n}`);
  });

  // ---------------- premium dashboard ----------------
  app.get('/api/dashboard/v2', async () => {
    const lineTotal = sql`(SELECT coalesce(sum((l->>'total_price')::numeric - coalesce((l->>'total_item_discount')::numeric, 0)), 0) FROM jsonb_array_elements(raw->'order_lines') l)`;
    const units = sql`(SELECT coalesce(sum((l->>'quantity')::numeric), 0) FROM jsonb_array_elements(raw->'order_lines') l)`;
    const daily = await rows(sql`SELECT to_char(d, 'YYYY-MM-DD') AS day,
        coalesce((SELECT count(*) FROM orders o WHERE o.order_date >= d AND o.order_date < d + interval '1 day' AND o.status <> 'CANCELED'), 0)::int AS orders,
        coalesce((SELECT sum(${lineTotal}) FROM orders o WHERE o.order_date >= d AND o.order_date < d + interval '1 day' AND o.status <> 'CANCELED'), 0)::float AS sales
      FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d ORDER BY d`);
    const k = (await rows(sql`SELECT
      coalesce(sum(${lineTotal}) FILTER (WHERE order_date >= date_trunc('day', now()) AND status <> 'CANCELED'), 0)::float AS sales_today,
      count(*) FILTER (WHERE order_date >= date_trunc('day', now()) AND status <> 'CANCELED')::int AS orders_today,
      coalesce(sum(${lineTotal}) FILTER (WHERE order_date > now() - interval '7 days' AND status <> 'CANCELED'), 0)::float AS sales7,
      coalesce(sum(${lineTotal}) FILTER (WHERE order_date > now() - interval '14 days' AND order_date <= now() - interval '7 days' AND status <> 'CANCELED'), 0)::float AS sales_prev7,
      coalesce(sum(${lineTotal}) FILTER (WHERE order_date > now() - interval '30 days' AND status <> 'CANCELED'), 0)::float AS sales30,
      count(*) FILTER (WHERE order_date > now() - interval '30 days' AND status <> 'CANCELED')::int AS orders30,
      coalesce(sum(${units}) FILTER (WHERE order_date > now() - interval '30 days' AND status <> 'CANCELED'), 0)::int AS units30,
      count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED'))::int AS open,
      count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date < now())::int AS late,
      count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date >= now() AND requested_shipment_date < now() + interval '24 hours')::int AS due24,
      count(*) FILTER (WHERE order_date > now() - interval '30 days' AND status = 'CANCELED')::int AS canceled30
      FROM orders`))[0];
    // top sellers (30 days) by TCIN
    const top = await rows(sql`SELECT l->>'tcin' AS tcin, max(l->>'external_id') AS sku, sum((l->>'quantity')::int)::int AS units,
        sum((l->>'total_price')::numeric - coalesce((l->>'total_item_discount')::numeric, 0))::float AS sales
      FROM orders o, jsonb_array_elements(o.raw->'order_lines') l WHERE o.order_date > now() - interval '30 days' AND o.status <> 'CANCELED'
      GROUP BY l->>'tcin' ORDER BY units DESC LIMIT 8`);
    const tcins = top.map((t) => t.tcin).filter(Boolean);
    const info = tcins.length ? await rows(sql`SELECT DISTINCT ON (v.tcin) v.tcin, v.sku, v.options, v.image_url, v.inventory, p.title, p.images->>0 AS pimg, p.id AS product_id
      FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.tcin IN (${sql.join(tcins.map((t) => sql`${t}`), sql`, `)})`) : [];
    const byT = new Map(info.map((i) => [i.tcin, i]));
    const topSellers = top.map((t) => { const i = byT.get(t.tcin); return { ...t, title: i?.title ?? t.sku, sku: i?.sku ?? t.sku, options: i ? Object.values(i.options ?? {}).join(' · ') : '', image: i?.image_url || i?.pimg || null, inventory: i?.inventory ?? null, productId: i?.product_id ?? null }; });
    // selling items running low (sold in 30 days, 0–2 left in Shopify)
    const low = await rows(sql`SELECT v.sku, v.tcin, v.inventory, v.options, v.image_url, p.title, p.images->>0 AS pimg, p.id AS product_id, s.units
      FROM (SELECT l->>'tcin' AS tcin, sum((l->>'quantity')::int)::int AS units FROM orders o, jsonb_array_elements(o.raw->'order_lines') l
            WHERE o.order_date > now() - interval '30 days' AND o.status <> 'CANCELED' GROUP BY 1) s
      JOIN variants v ON v.tcin = s.tcin LEFT JOIN products p ON p.id = v.product_id WHERE v.inventory <= 2 ORDER BY v.inventory, s.units DESC LIMIT 8`);
    const items = (await rows(sql`SELECT
      count(*) FILTER (WHERE listing_status = 'APPROVED')::int AS live, count(*) FILTER (WHERE listing_status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE listing_status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE listing_status = 'UNLISTED')::int AS unlisted,
      count(*) FILTER (WHERE listing_status = 'APPROVED' AND coalesce((SELECT sum(value::int) FROM jsonb_each_text(coalesce(last_qty_sent, '{}'::jsonb))), 0) > 0)::int AS live_in_stock
      FROM variants WHERE target_product_id IS NOT NULL`))[0];
    const recent = await rows(sql`SELECT id, order_number, status, order_date, requested_shipment_date, ${lineTotal}::float AS total FROM orders ORDER BY order_date DESC NULLS LAST LIMIT 6`);
    const holds = (await rows(sql`SELECT count(*)::int AS n FROM price_holds WHERE status = 'held'`))[0].n;
    const alertsOpen = await rows(sql`SELECT * FROM alerts WHERE resolved = false ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, at DESC LIMIT 6`);
    const sync = await getSetting<any>('sync', {});
    return { kpi: k, daily, topSellers, lowStock: low.map((x) => ({ ...x, image: x.image_url || x.pimg, options: Object.values(x.options ?? {}).join(' · ') })), items, recent, holds, alerts: alertsOpen,
      sync: { orders: !!sync.ordersEnabled, inventory: sync.inventoryEnabled !== false, price: sync.priceEnabled !== false, shopifyOrders: !!sync.pushOrdersToShopify } };
  });

  // ---------------- returns, enriched ----------------
  app.get('/api/returns/v2', async () => {
    const list: any[] = await T.listReturns({}).catch((e: any) => { throw bad(`Could not read returns from Target: ${e?.message ?? e}`); });
    const done = new Set(await getSetting<string[]>('returns.processed', []));
    const tcins = [...new Set(list.map((r) => r.tcin).filter(Boolean).map(String))];
    const info = tcins.length ? await rows(sql`SELECT DISTINCT ON (v.tcin) v.tcin, v.sku, v.options, v.image_url, p.title, p.images->>0 AS pimg, p.id AS product_id
      FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.tcin IN (${sql.join(tcins.map((t) => sql`${t}`), sql`, `)})`) : [];
    const byT = new Map(info.map((i) => [i.tcin, i]));
    const orders = await rows(sql`SELECT id, order_number, shopify_order_name FROM orders`);
    const oByNum = new Map(orders.map((o) => [String(o.order_number), o])), oById = new Map(orders.map((o) => [String(o.id), o]));
    const sold = (await rows(sql`SELECT coalesce(sum((l->>'quantity')::int), 0)::int AS units FROM orders o, jsonb_array_elements(o.raw->'order_lines') l WHERE o.order_date > now() - interval '90 days' AND o.status <> 'CANCELED'`))[0].units;
    const items = list.map((r) => {
      const i = byT.get(String(r.tcin)); const o = oById.get(String(r.order_id)) ?? oByNum.get(String(r.order_number));
      const rid = String(r.id ?? r.reference_id ?? '');
      return { id: rid, reference: r.reference_id ?? rid, orderNumber: r.order_number, orderId: o?.id ?? r.order_id ?? null, shopifyOrder: o?.shopify_order_name ?? null,
        tcin: r.tcin, sku: i?.sku ?? r.external_id, title: i?.title ?? r.external_id, options: i ? Object.values(i.options ?? {}).join(' · ') : '', image: i?.image_url || i?.pimg || null, productId: i?.product_id ?? null,
        quantity: Number(r.quantity || 1), reason: r.return_reason, date: r.return_date, financial: r.financial_disposition, physical: r.physical_disposition,
        tracking: (r.tracking_data ?? []).map((t: any) => t.tracking_number).filter(Boolean), inShopify: done.has(rid) };
    });
    const units = items.reduce((a, x) => a + x.quantity, 0);
    const last90 = items.filter((x) => x.date && Date.now() - new Date(x.date).getTime() < 90 * 864e5).reduce((a, x) => a + x.quantity, 0);
    const reasons: Record<string, number> = {};
    for (const x of items) reasons[x.reason ?? 'Unknown'] = (reasons[x.reason ?? 'Unknown'] ?? 0) + x.quantity;
    const byProduct = new Map<string, { title: string; image: string | null; units: number; productId: string | null }>();
    for (const x of items) { const key = x.productId ?? x.title; const e = byProduct.get(key) ?? { title: x.title, image: x.image, units: 0, productId: x.productId }; e.units += x.quantity; byProduct.set(key, e); }
    return { items, stats: { returns: items.length, units, last90, sold90: sold, rate90: sold ? Math.round((last90 / sold) * 1000) / 10 : null, inShopify: items.filter((x) => x.inShopify).length },
      reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]), topReturned: [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, 6) };
  });

  // log the user out of nothing: audit is written by the hook in index.ts
  app.get('/api/audit/whoami', async (req) => actorOf(req));
  void audit;
}

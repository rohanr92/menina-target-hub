// Alerts (in-app bell + optional Slack), activity log, and the daily summary.
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getSetting } from '../lib/settings.js';

export type Severity = 'info' | 'warning' | 'critical';

export interface AlertSettings {
  slackWebhookUrl?: string;
  /** send a morning summary to Slack (hour in the hub's server time zone, UTC on Railway) */
  dailySummaryHourUtc?: number | null;
  /** minimum severity that goes to Slack */
  slackMinSeverity?: Severity;
}
export const getAlertSettings = () => getSetting<AlertSettings>('alerts', { slackMinSeverity: 'warning', dailySummaryHourUtc: 13 });

const rank: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export async function postSlack(text: string) {
  const s = await getAlertSettings();
  if (!s.slackWebhookUrl) return false;
  try {
    const r = await fetch(s.slackWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    return r.ok;
  } catch { return false; }
}

/**
 * Raise an alert once: the same kind + ref is not raised again while an unresolved one exists from the last 12 hours.
 */
export async function raise(a: { kind: string; severity?: Severity; title: string; detail?: string; ref?: string; link?: string }) {
  const sev = a.severity ?? 'warning';
  const ref = a.ref ?? a.title;
  const dup = await db.execute(sql`SELECT id FROM alerts WHERE kind = ${a.kind} AND ref = ${ref} AND resolved = false AND at > now() - interval '12 hours' LIMIT 1`);
  if (dup.rows.length) return null;
  const r = await db.execute(sql`INSERT INTO alerts (kind, severity, title, detail, ref, link) VALUES (${a.kind}, ${sev}, ${a.title}, ${a.detail ?? null}, ${ref}, ${a.link ?? null}) RETURNING id`);
  const s = await getAlertSettings();
  if (rank[sev] >= rank[s.slackMinSeverity ?? 'warning']) {
    const icon = sev === 'critical' ? ':red_circle:' : sev === 'warning' ? ':warning:' : ':information_source:';
    await postSlack(`${icon} *Target Hub · ${a.title}*${a.detail ? `\n${a.detail}` : ''}`);
  }
  return (r.rows[0] as any)?.id ?? null;
}

/** Close alerts of a kind/ref when the problem is gone (e.g. the late order shipped). */
export async function resolve(kind: string, ref?: string) {
  if (ref) await db.execute(sql`UPDATE alerts SET resolved = true WHERE kind = ${kind} AND ref = ${ref} AND resolved = false`);
  else await db.execute(sql`UPDATE alerts SET resolved = true WHERE kind = ${kind} AND resolved = false`);
}

export async function audit(actor: string, action: string, target?: string | null, detail?: any, status?: number) {
  try {
    await db.execute(sql`INSERT INTO audit_log (actor, action, target, status, detail) VALUES (${actor}, ${action}, ${target ?? null}, ${status ?? null}, ${detail === undefined ? null : JSON.stringify(detail)}::jsonb)`);
  } catch { /* never block the action because of the log */ }
}

const SECRET = /pass|secret|token|apikey|api_key|authorization|clientsecret/i;
export function redact(v: any, depth = 0): any {
  if (v == null || depth > 4) return v;
  if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50).map((x) => redact(x, depth + 1)), `… ${v.length - 50} more`] : v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '•••' : redact(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

/** Order checks run with the scheduler: late or due-soon orders, orders stuck without a Shopify order. */
export async function checkOrderAlerts() {
  const late = (await db.execute(sql`SELECT id, order_number, requested_shipment_date FROM orders
    WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date < now()`)).rows as any[];
  for (const o of late) await raise({ kind: 'order-late', severity: 'critical', ref: o.id, title: `Order #${o.order_number} is late`, detail: `Ship-by was ${new Date(o.requested_shipment_date).toUTCString()}. Ship it or cancel the lines in the hub.`, link: `/orders/${encodeURIComponent(o.id)}` });
  const soon = (await db.execute(sql`SELECT id, order_number, requested_shipment_date FROM orders
    WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date >= now() AND requested_shipment_date < now() + interval '6 hours'`)).rows as any[];
  for (const o of soon) await raise({ kind: 'order-due', severity: 'warning', ref: o.id, title: `Order #${o.order_number} must ship within 6 hours`, link: `/orders/${encodeURIComponent(o.id)}` });
  // close alerts of orders that are no longer open
  await db.execute(sql`UPDATE alerts a SET resolved = true FROM orders o WHERE a.kind IN ('order-late','order-due','order-shopify','order-error') AND a.ref = o.id AND a.resolved = false AND o.status IN ('SHIPPED','CANCELED')`);
  const stuck = (await db.execute(sql`SELECT id, order_number, shopify_push_error FROM orders
    WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND shopify_order_id IS NULL AND shopify_push_error IS NOT NULL`)).rows as any[];
  for (const o of stuck) await raise({ kind: 'order-shopify', severity: 'critical', ref: o.id, title: `Order #${o.order_number} is not in Shopify`, detail: String(o.shopify_push_error).slice(0, 300), link: `/orders/${encodeURIComponent(o.id)}` });
  const errs = (await db.execute(sql`SELECT id, order_number, last_error FROM orders
    WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND last_error IS NOT NULL`)).rows as any[];
  for (const o of errs) await raise({ kind: 'order-error', severity: 'critical', ref: o.id, title: `Problem on order #${o.order_number}`, detail: String(o.last_error).slice(0, 300), link: `/orders/${encodeURIComponent(o.id)}` });
  return { late: late.length, soon: soon.length, stuck: stuck.length, errors: errs.length };
}

/** Morning summary (Slack). */
export async function dailySummary() {
  const r: any = (await db.execute(sql`SELECT
    count(*) FILTER (WHERE order_date > now() - interval '24 hours')::int AS orders24,
    coalesce(sum((SELECT sum((l->>'total_price')::numeric - coalesce((l->>'total_item_discount')::numeric, 0)) FROM jsonb_array_elements(raw->'order_lines') l)) FILTER (WHERE order_date > now() - interval '24 hours' AND status <> 'CANCELED'), 0)::float AS sales24,
    count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED'))::int AS open,
    count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date < now())::int AS late
    FROM orders`)).rows[0];
  const it: any = (await db.execute(sql`SELECT count(*) FILTER (WHERE listing_status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE listing_status = 'APPROVED')::int AS live FROM variants WHERE target_product_id IS NOT NULL`)).rows[0];
  const holds: any = (await db.execute(sql`SELECT count(*)::int AS n FROM price_holds WHERE status = 'held'`)).rows[0];
  const text = [
    `:sunrise: *Target Plus · daily summary*`,
    `Last 24h: *${r.orders24}* orders · *$${Number(r.sales24).toFixed(2)}*`,
    `Open orders: *${r.open}*${r.late ? ` · :red_circle: *${r.late} late*` : ''}`,
    `Items: ${it.live} live · ${it.rejected} rejected${holds.n ? ` · :warning: ${holds.n} price change(s) waiting for approval` : ''}`,
  ].join('\n');
  const sent = await postSlack(text);
  return { sent, text };
}

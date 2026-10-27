import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { reconcileInventoryAndPrice, runJob } from '../jobs/scheduler.js';
import { getActiveEnv, getSetting, getShopify, getSync, getTargetCreds, setSetting } from '../lib/settings.js';
import { refreshVariantsFromShopify } from '../services/catalog.js';
import * as O from '../services/orders.js';
import * as R from '../services/reports.js';
import { desiredQuantities, enqueue, enqueueMany, queueStats, targetVariantIds } from '../services/sync.js';
import * as TP from '../services/testplan.js';
import * as T from '../target/api.js';
import { targetRequest } from '../target/client.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

export default async function (app: FastifyInstance) {
  // ---------------- dashboard ----------------
  app.get('/api/dashboard', async () => {
    const q = async (s: any) => ((await db.execute(s)).rows[0] as any) ?? {};
    const items = await q(sql`SELECT
      count(*) FILTER (WHERE target_product_id IS NOT NULL)::int AS on_target,
      count(*) FILTER (WHERE listing_status = 'APPROVED')::int AS approved,
      count(*) FILTER (WHERE listing_status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE listing_status = 'REJECTED')::int AS rejected,
      count(*) FILTER (WHERE listing_status = 'SUSPENDED')::int AS suspended,
      count(*) FILTER (WHERE listing_status = 'UNLISTED')::int AS unlisted,
      count(*)::int AS variants FROM variants`);
    const products = await q(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE item_type_id IS NULL)::int AS unmapped FROM products`);
    const orders = await q(sql`SELECT
      count(*) FILTER (WHERE status = 'RELEASED_FOR_SHIPMENT')::int AS released,
      count(*) FILTER (WHERE status = 'ACKNOWLEDGED_BY_SELLER')::int AS acknowledged,
      count(*) FILTER (WHERE status = 'PARTIALLY_SHIPPED')::int AS partial,
      count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date < now())::int AS late,
      count(*) FILTER (WHERE status IN ('RELEASED_FOR_SHIPMENT','ACKNOWLEDGED_BY_SELLER','PARTIALLY_SHIPPED') AND requested_shipment_date < now() + interval '24 hours')::int AS due_soon,
      count(*)::int AS total FROM orders`);
    const tp = await q(sql`SELECT count(*) FILTER (WHERE owner = 'Partner')::int AS partner, count(*) FILTER (WHERE owner = 'Partner' AND status = 'Complete')::int AS done FROM test_scenarios`);
    const errors24h = await q(sql`SELECT count(*)::int AS n FROM api_logs WHERE created_at > now() - interval '24 hours' AND (status >= 400 OR error IS NOT NULL)`);
    const failedTasks = await q(sql`SELECT count(*)::int AS n FROM sync_tasks WHERE status = 'failed' AND updated_at > now() - interval '24 hours'`);
    const jobs = (await db.execute(sql`SELECT DISTINCT ON (job) job, status, message, started_at, finished_at FROM job_runs WHERE job NOT LIKE '%:%' ORDER BY job, started_at DESC`)).rows;
    const creds = await getTargetCreds();
    const shop = await getShopify();
    const setup = {
      targetCredentials: !!(creds.apiKey && creds.sellerId),
      shopify: !!(shop.shopDomain && shop.accessToken),
      itemTypes: ((await q(sql`SELECT count(*)::int AS n FROM item_types`)).n ?? 0) > 0,
      attributes: ((await q(sql`SELECT count(*)::int AS n FROM attributes`)).n ?? 0) > 0,
      distributionCenters: ((await q(sql`SELECT count(*)::int AS n FROM distribution_centers`)).n ?? 0) > 0,
      products: (products.total ?? 0) > 0,
      mapped: (products.total ?? 0) > 0 && products.unmapped < products.total,
      onTarget: (items.on_target ?? 0) > 0,
    };
    return { env: await getActiveEnv(), items, products, orders, testPlan: tp, errors24h: errors24h.n, failedTasks: failedTasks.n, queue: await queueStats(), jobs, setup, sync: await getSync() };
  });
  app.get('/api/jobs', async () => db.select().from(schema.jobRuns).orderBy(desc(schema.jobRuns.startedAt)).limit(100));

  // ---------------- sync ----------------
  app.get('/api/sync/status', async () => {
    const recent = await db.select({ t: schema.syncTasks, sku: schema.variants.sku }).from(schema.syncTasks)
      .leftJoin(schema.variants, eq(schema.variants.id, schema.syncTasks.variantId)).orderBy(desc(schema.syncTasks.updatedAt)).limit(100);
    return { stats: await queueStats(), recent: recent.map((r) => ({ ...r.t, sku: r.sku })) };
  });

  /** Stock per live SKU: Shopify quantity, what the hub will send per DC, what was last sent, last error. */
  app.get('/api/sync/stock', async () => {
    const sync = await getSync();
    const shop = await getShopify();
    const dcs = await db.select().from(schema.distributionCenters);
    const vs = await db.select().from(schema.variants).where(isNotNull(schema.variants.targetProductId)).orderBy(schema.variants.sku).limit(2000);
    const errs = vs.length ? await db.select().from(schema.syncTasks).where(and(eq(schema.syncTasks.kind, 'inventory'), inArray(schema.syncTasks.variantId, vs.map((v) => v.id)))).orderBy(desc(schema.syncTasks.updatedAt)) : [];
    const lastTask = new Map<string, any>();
    for (const t of errs) if (t.variantId && !lastTask.has(t.variantId)) lastTask.set(t.variantId, t);
    let planError: string | null = null;
    const rows: any[] = [];
    for (const v of vs) {
      let want: Record<string, number> | null = null;
      if (dcs.length && !planError) { try { want = await desiredQuantities(v); } catch (e: any) { planError = e?.message ?? String(e); } }
      const t = lastTask.get(v.id);
      rows.push({
        variantId: v.id, productId: v.productId, sku: v.sku, tcin: v.tcin, syncEnabled: v.syncEnabled,
        shopify: v.inventory, byLoc: v.inventoryByLoc, want, sent: v.lastQtySent ?? {}, sentAt: v.lastQtySentAt,
        shopifyPrice: v.price, compareAtPrice: v.compareAtPrice, priceSent: v.lastPriceSent ?? null, priceSentAt: v.lastPriceSentAt,
        stockFixed: (v.overrides as any)?.fixed_qty ?? null,
        priceOverride: (v.overrides as any)?.list_price ? { list_price: (v.overrides as any).list_price, offer_price: (v.overrides as any).offer_price ?? null, map_price: (v.overrides as any).map_price ?? null } : null,
        task: t ? { status: t.status, error: t.lastError, result: t.result, at: t.updatedAt } : null,
      });
    }
    return {
      inventoryEnabled: sync.inventoryEnabled, priceEnabled: sync.priceEnabled, intervalMin: sync.inventoryIntervalMin, safetyStock: sync.safetyStock,
      shopifyConnected: !!shop.accessToken, locationMap: shop.locationMap ?? {}, distributionCenters: dcs.map((d) => ({ id: d.id, name: d.name })),
      planError, rows,
    };
  });

  /** Fixed Target price for one SKU (list / offer / MAP). Sent right away; Shopify price rules are skipped for this SKU until cleared. */
  app.post('/api/variants/:id/set-price', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as { list_price?: any; offer_price?: any; map_price?: any; clear?: boolean };
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, id) });
    if (!v) throw bad('SKU not found', 404);
    const ov: Record<string, any> = { ...((v.overrides as any) ?? {}) };
    delete ov.list_price; delete ov.offer_price; delete ov.map_price;
    if (!b.clear) {
      const num = (x: any) => (x === '' || x == null ? null : Number(x));
      const list = num(b.list_price), offer = num(b.offer_price), map = num(b.map_price);
      if (!list || !(list > 0)) throw bad('List price is required and must be more than 0');
      if (offer != null && !(offer > 0 && offer <= list)) throw bad('Offer price must be more than 0 and not higher than the list price');
      if (map != null && !(map > 0 && map <= list)) throw bad('MAP price must be more than 0 and not higher than the list price');
      ov.list_price = list; if (offer != null) ov.offer_price = offer; if (map != null) ov.map_price = map;
    }
    await db.update(schema.variants).set({ overrides: ov }).where(eq(schema.variants.id, id));
    if (v.targetProductId) await enqueue('price', id, { force: true });
    return { ok: true, queued: !!v.targetProductId };
  });

  /** Fixed stock for one SKU per DC (sent right away; Shopify stock is ignored for this SKU until cleared). */
  app.post('/api/variants/:id/set-stock', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as { qty?: Record<string, any>; clear?: boolean };
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, id) });
    if (!v) throw bad('SKU not found', 404);
    const ov: Record<string, any> = { ...((v.overrides as any) ?? {}) };
    delete ov.fixed_qty;
    if (!b.clear) {
      const qty: Record<string, number> = {};
      for (const [dc, q] of Object.entries(b.qty ?? {})) {
        if (q === '' || q == null) continue;
        const n = Number(q);
        if (!Number.isInteger(n) || n < 0) throw bad('Stock must be a whole number, 0 or more');
        qty[dc] = n;
      }
      if (!Object.keys(qty).length) throw bad('Enter a quantity for at least one warehouse');
      ov.fixed_qty = qty;
    }
    await db.update(schema.variants).set({ overrides: ov }).where(eq(schema.variants.id, id));
    if (v.targetProductId) await enqueue('inventory', id, { force: true });
    return { ok: true, queued: !!v.targetProductId };
  });

  /** Turn automatic stock + price sync on/off. */
  app.post('/api/sync/auto', async (req) => {
    const { on } = (req.body ?? {}) as { on?: boolean };
    const cur = await getSetting<any>('sync', {});
    await setSetting('sync', { ...cur, inventoryEnabled: on !== false, priceEnabled: on !== false });
    return { ok: true, on: on !== false };
  });

  /** Send stock now for some SKUs (or all live SKUs): refresh from Shopify first, then push every DC. */
  app.post('/api/sync/stock/send', async (req) => {
    const { variantIds } = (req.body ?? {}) as { variantIds?: string[] };
    const conds = [isNotNull(schema.variants.targetProductId), eq(schema.variants.syncEnabled, true)];
    if (Array.isArray(variantIds) && variantIds.length) conds.push(inArray(schema.variants.id, variantIds.map(String)));
    const rows = await db.select({ id: schema.variants.id, sourceId: schema.variants.sourceId, inventory: schema.variants.inventory, price: schema.variants.price, compareAtPrice: schema.variants.compareAtPrice })
      .from(schema.variants).where(and(...conds));
    if (rows.some((r) => r.sourceId.startsWith('gid://'))) await refreshVariantsFromShopify(rows);
    // make sure the DCs exist before the queue runs (loads them from Target on first use)
    const dcs = await db.select().from(schema.distributionCenters);
    if (!dcs.length) { const { syncSetupData } = await import('../services/taxonomy.js'); await syncSetupData(); }
    await enqueueMany('inventory', rows.map((r) => r.id), { force: true });
    return { queued: rows.length };
  });
  app.post('/api/sync/run', async (req) => {
    const { kind = 'all', force } = (req.body ?? {}) as { kind?: 'inventory' | 'price' | 'all'; force?: boolean };
    const rows = await db.select({ id: schema.variants.id, sourceId: schema.variants.sourceId, inventory: schema.variants.inventory, price: schema.variants.price, compareAtPrice: schema.variants.compareAtPrice })
      .from(schema.variants).where(and(isNotNull(schema.variants.targetProductId), eq(schema.variants.syncEnabled, true)));
    if (rows.some((r) => r.sourceId.startsWith('gid://'))) await refreshVariantsFromShopify(rows);
    const ids = rows.map((r) => r.id);
    if (kind === 'all' || kind === 'inventory') await enqueueMany('inventory', ids, { force });
    if (kind === 'all' || kind === 'price') await enqueueMany('price', ids, { force });
    return { queued: ids.length };
  });
  app.post('/api/sync/reconcile', async () => runJob('inventory', reconcileInventoryAndPrice));
  app.post('/api/sync/retry-failed', async () => {
    const failed = await db.select().from(schema.syncTasks).where(eq(schema.syncTasks.status, 'failed'));
    for (const t of failed) if (t.variantId) await enqueue(t.kind as any, t.variantId, { force: true });
    await db.delete(schema.syncTasks).where(eq(schema.syncTasks.status, 'failed'));
    return { retried: failed.length };
  });

  // ---------------- orders ----------------
  app.get('/api/orders', async (req) => {
    const { status, q } = req.query as any;
    const conds: any[] = [];
    if (status === 'open') conds.push(inArray(schema.orders.status, ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED']));
    else if (status) conds.push(eq(schema.orders.status, status));
    if (q) conds.push(or(ilike(schema.orders.orderNumber, `%${q}%`), eq(schema.orders.id, q)));
    const rows = await db.select().from(schema.orders).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.orders.orderDate)).limit(300);
    return rows.map((o) => {
      const lines = (o.raw as any)?.order_lines ?? [];
      return {
        id: o.id, orderNumber: o.orderNumber, status: o.status, orderDate: o.orderDate, requestedShipmentDate: o.requestedShipmentDate,
        requestedDeliveryDate: o.requestedDeliveryDate, lines: lines.length, units: lines.reduce((a: number, l: any) => a + Number(l.quantity || 0), 0),
        total: lines.reduce((a: number, l: any) => a + Number(l.total_price || 0), 0), shopifyOrderName: o.shopifyOrderName, lastError: o.lastError ?? o.shopifyPushError,
        customer: (o.address as any)?.shipping_address ? `${(o.address as any).shipping_address.first_name ?? ''} ${(o.address as any).shipping_address.last_name ?? ''}`.trim() : null,
      };
    });
  });
  app.get('/api/orders/:id', async (req) => {
    const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, (req.params as any).id) });
    if (!o) throw bad('Order not found', 404);
    const skus = ((o.raw as any)?.order_lines ?? []).map((l: any) => l.external_id).filter(Boolean);
    const vs = skus.length ? await db.select({ sku: schema.variants.sku, productId: schema.variants.productId, title: schema.variants.title, imageUrl: schema.variants.imageUrl }).from(schema.variants).where(inArray(schema.variants.sku, skus)) : [];
    return { ...o, items: vs, shippingMethods: await db.select().from(schema.shippingMethods) };
  });
  app.post('/api/orders/poll', async () => runJob('orders', O.pollOrders));
  app.post('/api/orders/import', async (req) => {
    // pull orders in any status (e.g. to load test orders already acknowledged elsewhere)
    const { status } = (req.body ?? {}) as { status?: string };
    const list = await T.listOrders({ order_status: status || 'RELEASED_FOR_SHIPMENT,ACKNOWLEDGED_BY_SELLER,PARTIALLY_SHIPPED,SHIPPED,CANCELED' });
    for (const o of list) await O.refreshOrder(String(o.id)).catch(() => undefined);
    return { imported: list.length };
  });
  app.post('/api/orders/:id/refresh', async (req) => O.refreshOrder((req.params as any).id));
  app.post('/api/orders/:id/acknowledge', async (req) => O.acknowledge((req.params as any).id));
  app.post('/api/orders/:id/address', async (req) => O.fetchAddress((req.params as any).id));
  app.post('/api/orders/:id/ship', async (req) => O.shipOrder((req.params as any).id, (req.body as any).lines ?? []));
  app.post('/api/orders/:id/cancel', async (req) => {
    const { lines, reason } = req.body as { lines: { order_line_number: string; quantity: number }[]; reason: string };
    if (!reason) throw bad('Cancellation reason is required');
    const out: any[] = [];
    for (const l of lines ?? []) if (l.quantity > 0) out.push(await O.cancelLine((req.params as any).id, l.order_line_number, l.quantity, reason));
    return out;
  });
  app.put('/api/orders/:id/fulfillments', async (req) => {
    const res = await T.updateFulfillments((req.params as any).id, (req.body as any).items);
    await O.refreshOrder((req.params as any).id);
    return res;
  });
  app.post('/api/orders/:id/push-shopify', async (req) => O.pushOrderToShopify((req.params as any).id));
  app.post('/api/orders/tracking-sync', async () => runJob('tracking', O.syncTrackingFromShopify));

  // ---------------- reports ----------------
  app.get('/api/reports', async () => ({
    types: T.REPORT_TYPES,
    reports: await db.select().from(schema.reportRequests).orderBy(desc(schema.reportRequests.createdAt)).limit(200),
  }));
  app.post('/api/reports', async (req) => R.requestReport(req.body as any));
  app.post('/api/reports/sync', async () => ({ imported: await R.syncReportList() }));
  app.post('/api/reports/:id/refresh', async (req) => R.refreshReport((req.params as any).id));
  app.post('/api/reports/:id/cancel', async (req) => R.cancel((req.params as any).id));
  app.post('/api/reports/:id/import-item-types', async (req) => R.importAllowedItemTypes((req.params as any).id));
  app.get('/api/reports/:id/download', async (req, reply) => {
    const r = await db.query.reportRequests.findFirst({ where: eq(schema.reportRequests.id, (req.params as any).id) });
    const { data, contentType } = await R.download((req.params as any).id);
    const ext = /json/.test(contentType) ? 'json' : /csv/.test(contentType) ? 'csv' : /sheet|excel/.test(contentType) ? 'xlsx' : (r?.format ?? 'txt').toLowerCase().replace('excel', 'xlsx');
    reply.header('content-type', contentType || 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${r?.type ?? 'report'}-${r?.id}.${ext}"`);
    return typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
  });
  app.get('/api/reports/:id/preview', async (req) => {
    const t = await R.reportTable((req.params as any).id, { q: (req.query as any).q || undefined, limit: 300 });
    return { total: t.total, rows: t.rows };
  });
  /** Full report as a table to read inside the hub (Excel, CSV and JSON). */
  app.get('/api/reports/:id/view', async (req) => {
    const { q } = req.query as any;
    return R.reportTable((req.params as any).id, { q: q || undefined, limit: 2000 });
  });
  /** One-click report presets (Test plan › Reporting). */
  app.post('/api/reports/quick', async (req) => {
    const { preset } = (req.body ?? {}) as { preset: string };
    const now = new Date(); const ago30 = new Date(Date.now() - 30 * 864e5);
    const presets: Record<string, any> = {
      item_errors: { type: 'ITEM_ERRORS', format: 'JSON' },
      item_errors_v2: { type: 'ITEM_ERRORS_V2', format: 'JSON' },
      inventory_published: { type: 'INVENTORY', format: 'CSV', parameters: { is_published: true } },
      inventory_unpublished: { type: 'INVENTORY', format: 'CSV', parameters: { is_published: false } },
      orders_30d: { type: 'ORDERS', format: 'JSON', start_date: ago30.toISOString(), end_date: now.toISOString() },
      allowed_item_types: { type: 'ALLOWED_ITEM_TYPES', format: 'EXCEL' },
      logistic_errors: { type: 'PRODUCT_LOGISTIC_ERRORS', format: 'JSON' },
      inconsistencies: { type: 'ITEM_INCONSISTENCIES', format: 'JSON' },
    };
    const body = presets[preset];
    if (!body) throw bad('Unknown report');
    return R.requestReport(body);
  });

  // ---------------- returns ----------------
  app.get('/api/returns', async (req) => T.listReturns(req.query as any));
  app.get('/api/returns/disputes', async () => T.listReturnDisputes());

  // ---------------- test plan ----------------
  app.get('/api/testplan', async () => TP.listScenarios());
  app.patch('/api/testplan/:id', async (req) => TP.updateScenario(decodeURIComponent((req.params as any).id), req.body as any));
  app.post('/api/testplan/:id/suggest', async (req) => ({ identifiers: await TP.suggestIdentifiers(decodeURIComponent((req.params as any).id), (req.body ?? {}) as any) }));
  app.post('/api/testplan/template', async (req) => {
    const file = await req.file();
    if (!file) throw bad('No file');
    await TP.saveTemplate(await file.toBuffer());
    return { ok: true };
  });
  app.get('/api/testplan/export', async (_req, reply) => {
    const buf = await TP.exportWorkbook();
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="API Integration Test Plan - Menina Step (${new Date().toISOString().slice(0, 10)}).xlsx"`);
    return reply.send(buf);
  });

  // ---------------- API console (any Target endpoint, e.g. error-path scenarios) ----------------
  app.post('/api/console', async (req) => {
    const { api, method, path, query, body } = req.body as { api: 'sellers' | 'orders' | 'taxonomy'; method: string; path: string; query?: Record<string, string>; body?: any };
    if (!['sellers', 'orders', 'taxonomy'].includes(api)) throw bad('api must be sellers, orders or taxonomy');
    if (!path?.startsWith('/')) throw bad('path must start with /');
    const creds = await getTargetCreds();
    const p = path.replace('{seller_id}', encodeURIComponent(creds.sellerId ?? ''));
    try {
      const r = await targetRequest(api, method.toUpperCase(), p, { query, body: body === '' || body === undefined || body === null ? undefined : body, source: 'console', retries: 0 });
      return { ok: true, status: r.status, total: r.total ?? null, data: r.data };
    } catch (e: any) {
      return { ok: false, status: e.status ?? 0, error: e.message, data: e.body ?? null };
    }
  });

  // ---------------- API log ----------------
  app.get('/api/logs', async (req) => {
    const { service, failed, q, page = '1' } = req.query as any;
    const conds: any[] = [];
    if (service) conds.push(eq(schema.apiLogs.service, service));
    if (failed === '1') conds.push(sql`(status >= 400 OR error IS NOT NULL)`);
    if (q) conds.push(or(ilike(schema.apiLogs.url, `%${q}%`), ilike(schema.apiLogs.responseBody, `%${q}%`), ilike(schema.apiLogs.requestBody, `%${q}%`)));
    const limit = 50;
    const rows = await db.select({ id: schema.apiLogs.id, createdAt: schema.apiLogs.createdAt, service: schema.apiLogs.service, env: schema.apiLogs.env, method: schema.apiLogs.method, url: schema.apiLogs.url, status: schema.apiLogs.status, durationMs: schema.apiLogs.durationMs, error: schema.apiLogs.error, source: schema.apiLogs.source })
      .from(schema.apiLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.apiLogs.id)).limit(limit).offset((Number(page) - 1) * limit);
    return rows;
  });
  app.get('/api/logs/:id', async (req) => db.query.apiLogs.findFirst({ where: eq(schema.apiLogs.id, Number((req.params as any).id)) }));

  // ---------------- Shopify webhooks (inventory_levels/update, products/update) ----------------
  const pendingInventoryItems = new Set<string>();
  const pendingVariants = new Set<string>();
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = async () => {
    flushTimer = null;
    const invIds = [...pendingInventoryItems]; pendingInventoryItems.clear();
    const varIds = [...pendingVariants]; pendingVariants.clear();
    const rows = await db.select({ id: schema.variants.id, sourceId: schema.variants.sourceId, inventory: schema.variants.inventory, price: schema.variants.price, compareAtPrice: schema.variants.compareAtPrice })
      .from(schema.variants).where(or(invIds.length ? inArray(schema.variants.inventoryItemId, invIds) : sql`false`, varIds.length ? inArray(schema.variants.sourceId, varIds) : sql`false`));
    if (!rows.length) return;
    const changed = await refreshVariantsFromShopify(rows);
    const sync = await getSync();
    for (const id of changed) {
      if (sync.inventoryEnabled) await enqueue('inventory', id);
      if (sync.priceEnabled) await enqueue('price', id);
    }
  };
  app.post('/api/webhooks/shopify', async (req, reply) => {
    const shop = await getShopify();
    const hmac = String(req.headers['x-shopify-hmac-sha256'] ?? '');
    if (!shop.webhookSecret) return reply.code(401).send({ error: 'Webhook secret not configured' });
    const digest = createHmac('sha256', shop.webhookSecret).update((req as any).rawBody ?? Buffer.alloc(0)).digest('base64');
    const a = Buffer.from(digest), b = Buffer.from(hmac);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: 'Bad signature' });
    const topic = String(req.headers['x-shopify-topic'] ?? '');
    const body: any = req.body;
    if (topic === 'inventory_levels/update' && body?.inventory_item_id) pendingInventoryItems.add(`gid://shopify/InventoryItem/${body.inventory_item_id}`);
    if (topic === 'products/update') for (const v of body?.variants ?? []) pendingVariants.add(v.admin_graphql_api_id ?? `gid://shopify/ProductVariant/${v.id}`);
    // debounce: batch rapid changes together
    if (!flushTimer) flushTimer = setTimeout(() => { flush().catch((e) => console.error('webhook flush', e)); }, 4000);
    return { ok: true };
  });

  app.get('/api/targets/variant-ids', async () => ({ ids: await targetVariantIds() }));
}

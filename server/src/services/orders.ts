// Target order lifecycle: pull released orders, acknowledge, address, ship (full/partial), cancel (full/partial),
// push into Shopify (or deduct Shopify stock) and tracking sync back from Shopify fulfillments.
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getActiveEnv, getShopify, getSync } from '../lib/settings.js';
import {
  INVENTORY_ADJUST, ORDER_BY_TAG, ORDER_CREATE, ORDER_FULFILLMENTS_QUERY, ORDER_LINES_QUERY, REFUND_CREATE, shopifyGraphql, TAGS_ADD, VARIANT_LOOKUP,
} from '../shopify/client.js';
import { getSetting, setSetting } from '../lib/settings.js';
import * as T from '../target/api.js';
import { enqueue } from './sync.js';

const OPEN = ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED'];
const errMsg = (e: any) => e?.message ?? String(e);

type Variant = typeof schema.variants.$inferSelect;
/**
 * Which Shopify variant is this Target order line? UPC first, then SKU, then the item linked to the TCIN.
 * (Items listed by the old app have SKUs like "#shop-…", so UPC matching is what normally hits.)
 */
export async function resolveLineVariant(l: any): Promise<{ gid?: string; local?: Variant; by?: string; barcode?: string }> {
  const env = await getActiveEnv();
  const tItem = l.tcin ? await db.query.targetItems.findFirst({ where: and(eq(schema.targetItems.env, env), eq(schema.targetItems.tcin, String(l.tcin))) }) : null;
  const linked = l.tcin ? await db.query.variants.findFirst({ where: eq(schema.variants.tcin, String(l.tcin)) }) : null;
  const barcode = (tItem?.barcode || l.barcode || linked?.barcode || '').trim();
  const isGid = (v?: Variant | null) => !!v?.sourceId?.startsWith('gid://shopify/ProductVariant/');
  if (barcode) {
    const local = await db.query.variants.findFirst({ where: eq(schema.variants.barcode, barcode) });
    if (isGid(local)) return { gid: local!.sourceId, local: local!, by: 'upc', barcode };
    const d: any = await shopifyGraphql(VARIANT_LOOKUP, { q: `barcode:${JSON.stringify(barcode)}` }, 'shopify-order');
    const hit = d.productVariants.nodes.find((n: any) => n.barcode === barcode);
    if (hit) return { gid: hit.id, local: (await db.query.variants.findFirst({ where: eq(schema.variants.sourceId, hit.id) })) ?? undefined, by: 'upc', barcode };
  }
  const sku = l.external_id ? String(l.external_id) : '';
  if (sku && !sku.startsWith('#shop-')) {
    const local = await db.query.variants.findFirst({ where: eq(schema.variants.sku, sku) });
    if (isGid(local)) return { gid: local!.sourceId, local: local!, by: 'sku', barcode };
    const d: any = await shopifyGraphql(VARIANT_LOOKUP, { q: `sku:${JSON.stringify(sku)}` }, 'shopify-order');
    const hit = d.productVariants.nodes.find((n: any) => n.sku === sku);
    if (hit) return { gid: hit.id, local: (await db.query.variants.findFirst({ where: eq(schema.variants.sourceId, hit.id) })) ?? undefined, by: 'sku', barcode };
  }
  // old-app SKUs "#shop-<variant id>" carry the Shopify variant id itself
  const m = sku.match(/^#shop-(\d+)$/);
  if (m) {
    const gid = `gid://shopify/ProductVariant/${m[1]}`;
    const local = await db.query.variants.findFirst({ where: eq(schema.variants.sourceId, gid) });
    if (local) return { gid, local, by: 'shopify id', barcode };
  }
  if (isGid(linked)) return { gid: linked!.sourceId, local: linked!, by: 'tcin', barcode };
  return { barcode };
}

/** Orders dated before the switch to the hub were handled by the old integration. */
async function beforeCutover(o: { orderDate: Date | null }) {
  const { ordersCutoverAt } = await getSync();
  return !!(ordersCutoverAt && o.orderDate && o.orderDate.getTime() < new Date(ordersCutoverAt).getTime());
}

async function upsertOrder(o: any) {
  const row = {
    id: String(o.id), orderNumber: o.order_number ?? null, status: o.order_status ?? o.status ?? 'UNKNOWN', // Target sends order_status
    orderDate: o.order_date ? new Date(o.order_date) : null,
    requestedShipmentDate: o.requested_shipment_date ? new Date(o.requested_shipment_date) : null,
    requestedDeliveryDate: o.requested_delivery_date ? new Date(o.requested_delivery_date) : null,
    raw: o,
  };
  const existing = await db.query.orders.findFirst({ where: eq(schema.orders.id, row.id) });
  if (existing) await db.update(schema.orders).set(row).where(eq(schema.orders.id, row.id));
  else await db.insert(schema.orders).values(row);
  return { isNew: !existing, existing };
}

function qtyIn(line: any, status: string) {
  return (line.order_line_statuses ?? []).filter((s: any) => s.status === status).reduce((a: number, s: any) => a + Number(s.quantity || 0), 0);
}
const openQty = (l: any) => qtyIn(l, 'ACKNOWLEDGED_BY_SELLER') + qtyIn(l, 'PENDING');
const soldQty = (l: any) => openQty(l) + qtyIn(l, 'SHIPPED');

/**
 * Make Shopify aware of a Target sale: either create the order in Shopify (stock decrements there),
 * or, when order push is off, deduct the units from Shopify stock directly. Then push fresh quantities to Target.
 */
/** Stage test orders must never touch the real Shopify store unless explicitly allowed. */
export async function shopifyWritesAllowed() {
  const sync = await getSync();
  const shop = await getShopify();
  if (!shop.shopDomain || !shop.accessToken) return false;
  return (await getActiveEnv()) === 'production' || sync.stage.allowShopifyWrites;
}

async function reflectInShopify(orderId: string) {
  const sync = await getSync();
  if (!(await shopifyWritesAllowed())) return;
  const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  if (!o || o.shopifyOrderId) return;
  if (await beforeCutover(o)) return;
  if (sync.pushOrdersToShopify) await pushOrderToShopify(orderId);
  else if (sync.deductShopifyStock) await adjustShopifyStock(orderId);
}

/** Deduct sold units (or give back canceled units) in Shopify so its stock stays the source of truth. */
export async function adjustShopifyStock(orderId: string) {
  const sync = await getSync();
  if (!sync.deductShopifyStock || sync.pushOrdersToShopify || !(await shopifyWritesAllowed())) return;
  const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  if (!o || o.shopifyOrderId) return;
  const shop = await getShopify();
  const map = shop.locationMap ?? {};
  const raw: any = o.raw;
  const adjusted = { ...((o.shopifyStockAdjusted ?? {}) as Record<string, number>) };
  const bySku = new Map<string, number>();
  const lineOf = new Map<string, any>();
  for (const l of raw.order_lines ?? []) if (l.external_id) { bySku.set(l.external_id, (bySku.get(l.external_id) ?? 0) + soldQty(l)); lineOf.set(l.external_id, l); }
  for (const [sku, sold] of bySku) {
    const delta = sold - (adjusted[sku] ?? 0); // >0: deduct more, <0: give back (cancellation)
    if (!delta) continue;
    const v = (await resolveLineVariant(lineOf.get(sku))).local;
    if (!v?.inventoryItemId) continue;
    // location: the one mapped to the order's DC, else the mapped location with most stock, else most stock overall
    const byLoc = (v.inventoryByLoc ?? {}) as Record<string, number>;
    const forDc = Object.entries(map).find(([, dc]) => dc === raw.distribution_center_id)?.[0];
    const candidates = Object.keys(map).length ? Object.keys(map) : Object.keys(byLoc);
    const locationId = forDc ?? candidates.sort((a, b) => (byLoc[b] ?? 0) - (byLoc[a] ?? 0))[0];
    if (!locationId?.startsWith('gid://shopify/Location/')) continue;
    const d: any = await shopifyGraphql(INVENTORY_ADJUST, {
      input: {
        reason: 'correction', name: 'available',
        referenceDocumentUri: `gid://menina-target-hub/TargetOrder/${encodeURIComponent(o.id)}`,
        changes: [{ delta: -delta, inventoryItemId: v.inventoryItemId, locationId }],
      },
    }, 'shopify-stock-adjust');
    const errs = d.inventoryAdjustQuantities.userErrors ?? [];
    if (errs.length) throw new Error(`Shopify stock adjust for ${sku}: ${errs.map((e: any) => e.message).join('; ')}`);
    adjusted[sku] = sold;
    await db.update(schema.orders).set({ shopifyStockAdjusted: adjusted }).where(eq(schema.orders.id, o.id));
    await db.update(schema.variants).set({ inventoryByLoc: { ...byLoc, [locationId]: (byLoc[locationId] ?? 0) - delta }, inventory: Math.max(0, v.inventory - delta) }).where(eq(schema.variants.id, v.id));
  }
}

/** Pull new + open orders. New RELEASED_FOR_SHIPMENT orders get their address, an acknowledgement and are reflected in Shopify. */
export async function pollOrders() {
  const sync = await getSync();
  const released = await T.listOrders({ order_status: 'RELEASED_FOR_SHIPMENT' });
  let created = 0, acknowledged = 0;
  for (const o of released) {
    const id = String(o.id);
    const { isNew } = await upsertOrder(o);
    if (isNew) created++;
    try {
      const cur = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
      if (!cur?.address) await fetchAddress(id);
      if (sync.autoAcknowledge) { await acknowledge(id); acknowledged++; }
    } catch (e) {
      await db.update(schema.orders).set({ lastError: errMsg(e) }).where(eq(schema.orders.id, id));
    }
  }
  // keep open orders in sync (status changes made in the portal / by Target)
  const open = await db.select().from(schema.orders).where(inArray(schema.orders.status, OPEN));
  for (const o of open) {
    if (released.some((r: any) => String(r.id) === o.id)) continue;
    try { await refreshOrder(o.id); } catch { /* keep going */ }
  }
  // reflect every open order in Shopify (retries earlier failures too), then refresh Target stock for its SKUs
  const pending = await db.select().from(schema.orders).where(and(inArray(schema.orders.status, OPEN), isNull(schema.orders.shopifyOrderId)));
  for (const o of pending) {
    try { await reflectInShopify(o.id); } catch (e) {
      await db.update(schema.orders).set({ shopifyPushError: errMsg(e) }).where(eq(schema.orders.id, o.id));
    }
    await requeueInventoryForOrder(o.id);
  }
  return { released: released.length, created, acknowledged };
}

export async function refreshOrder(orderId: string) {
  const o = await T.getOrder(orderId);
  await upsertOrder(o);
  try {
    const f = await T.getFulfillments(orderId);
    await db.update(schema.orders).set({ fulfillments: f }).where(eq(schema.orders.id, orderId));
  } catch { /* none yet */ }
  return db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
}

export async function fetchAddress(orderId: string) {
  const addr = await T.getOrderAddress(orderId);
  await db.update(schema.orders).set({ address: addr }).where(eq(schema.orders.id, orderId));
  return addr;
}

export async function acknowledge(orderId: string) {
  const r = await T.setOrderStatus(orderId, 'ACKNOWLEDGED_BY_SELLER');
  await db.update(schema.orders).set({ acknowledgedAt: new Date(), lastError: null }).where(eq(schema.orders.id, orderId));
  await refreshOrder(orderId);
  return r;
}

function lineOf(order: any, lineNumber: string) {
  const line = (order.raw?.order_lines ?? []).find((l: any) => String(l.order_line_number) === String(lineNumber));
  if (!line) throw new Error(`Order line ${lineNumber} not found`);
  return line;
}

export interface ShipLine { order_line_number: string; quantity: number; tracking_number: string; shipping_method: string; shipped_date?: string }

/** Ship one or more lines (full or partial quantity). Target fulfills at line level. */
export async function shipOrder(orderId: string, lines: ShipLine[]) {
  // always work from Target's current view so a repeated click / retry can't ship twice
  const order = await refreshOrder(orderId);
  if (!order) throw new Error('Order not found');
  const existing: any[] = Array.isArray(order.fulfillments) ? (order.fulfillments as any[]) : [];
  const methods = await db.select().from(schema.shippingMethods);
  const items: T.FulfillmentItem[] = [];
  for (const l of lines.filter((x) => x.quantity > 0)) {
    const line = lineOf(order, l.order_line_number);
    const open = openQty(line);
    if (!l.tracking_number?.trim()) throw new Error(`Line ${l.order_line_number}: tracking number required`);
    if (existing.some((f) => String(f.order_line_number) === String(l.order_line_number) && f.tracking_number === l.tracking_number.trim() && Number(f.quantity) === l.quantity)) continue; // already sent
    if (l.quantity > open) throw new Error(`Line ${l.order_line_number}: shipping ${l.quantity} but only ${open} open`);
    const m = methods.find((x) => x.shippingMethod === l.shipping_method);
    if (methods.length && !m) throw new Error(`"${l.shipping_method}" is not one of your Target shipping methods`);
    const shipped = l.shipped_date ? new Date(l.shipped_date) : new Date();
    if (order.orderDate && shipped < order.orderDate) throw new Error('Ship date cannot be before the order date');
    items.push({
      order_line_number: String(l.order_line_number), quantity: l.quantity, tracking_number: l.tracking_number.trim(),
      shipping_method: l.shipping_method, shipped_date: shipped.toISOString(), level_of_service: m?.serviceCode || undefined,
    });
  }
  if (!items.length) return { results: [], skipped: 'already sent' };
  let res: any;
  try {
    res = await T.createFulfillments(orderId, items);
  } catch (e: any) {
    // Unclear outcome (timeout / 5xx): check what Target recorded before reporting failure
    if (e?.ambiguous) {
      const after = await refreshOrder(orderId).catch(() => null);
      const f: any[] = Array.isArray(after?.fulfillments) ? (after!.fulfillments as any[]) : [];
      if (items.every((it) => f.some((x) => String(x.order_line_number) === it.order_line_number && x.tracking_number === it.tracking_number))) return { results: f, recovered: true };
    }
    throw e;
  }
  // the fulfillment is recorded; refreshing local state must not turn this into a reported failure
  try { await refreshOrder(orderId); } catch { /* next poll catches up */ }
  try { if (!(await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))?.shopifyOrderId) await adjustShopifyStock(orderId); } catch { /* retried on next poll */ }
  await requeueInventoryForOrder(orderId).catch(() => undefined);
  return res;
}

/**
 * Cancel quantity on a line. Target needs the full status breakdown of the line, with the
 * cancelled quantity moved out of ACKNOWLEDGED_BY_SELLER/PENDING into CANCELED.
 */
export async function cancelLine(orderId: string, lineNumber: string, quantity: number, reason: string) {
  const order = await refreshOrder(orderId);
  if (!order) throw new Error('Order not found');
  const line = lineOf(order, lineNumber);
  const total = Number(line.quantity);
  let shipped = qtyIn(line, 'SHIPPED');
  const canceled = qtyIn(line, 'CANCELED');
  let ack = qtyIn(line, 'ACKNOWLEDGED_BY_SELLER');
  let pending = qtyIn(line, 'PENDING');
  // Target can take a moment to move shipped units into SHIPPED after a fulfillment. Use the fulfillments we sent,
  // so the payload always carries the real SHIPPED quantity (Target: include the shipped quantity, never a 0 status).
  const fulfilled = (Array.isArray(order.fulfillments) ? (order.fulfillments as any[]) : [])
    .filter((f) => String(f.order_line_number) === String(line.order_line_number))
    .reduce((a, f) => a + Number(f.quantity || 0), 0);
  if (fulfilled > shipped) {
    let extra = Math.min(fulfilled - shipped, ack + pending);
    shipped += extra;
    const fromAck = Math.min(ack, extra); ack -= fromAck; extra -= fromAck;
    pending -= Math.min(pending, extra);
  }
  const open = ack + pending;
  if (quantity < 1 || quantity > open) throw new Error(`Line ${lineNumber}: can cancel 1-${open} (shipped ${shipped}, already canceled ${canceled})`);
  const fromPending = Math.min(pending, quantity);
  const fromAck = quantity - fromPending;
  const statuses = [
    { status: 'CANCELED', quantity: canceled + quantity },
    { status: 'ACKNOWLEDGED_BY_SELLER', quantity: ack - fromAck },
    { status: 'PENDING', quantity: pending - fromPending },
    { status: 'SHIPPED', quantity: shipped },
  ].filter((s) => s.quantity > 0);
  const sum = statuses.reduce((a, s) => a + s.quantity, 0);
  if (sum !== total) throw new Error(`Status quantities (${sum}) must equal the line quantity (${total})`);
  const res = await T.updateOrderLine(orderId, String(line.order_line_number), { cancellation_reason: reason, order_line_statuses: statuses });
  try { await refreshOrder(orderId); } catch { /* next poll */ }
  // give the units back to Shopify stock if we had deducted them
  try { if (!order.shopifyOrderId) await adjustShopifyStock(orderId); } catch { /* retried on next poll */ }
  await requeueInventoryForOrder(orderId).catch(() => undefined);
  return res;
}

/**
 * Ship some quantity and cancel what is left on those lines in one go
 * (Target test plan 1.4 / 2.4 / 3.4: "ship one, cancel the unshipped quantity").
 */
export async function shipAndCancelRest(orderId: string, lines: ShipLine[], reason: string) {
  const before = await refreshOrder(orderId);
  if (!before) throw new Error('Order not found');
  const want = lines.filter((l) => l.quantity > 0);
  if (!want.length) throw new Error('Enter a ship quantity for at least one line');
  const openBefore = new Map(want.map((l) => [String(l.order_line_number), openQty(lineOf(before, l.order_line_number))]));
  const shipRes = await shipOrder(orderId, want);
  const canceled: any[] = [];
  for (const l of want) {
    const left = (openBefore.get(String(l.order_line_number)) ?? 0) - l.quantity;
    if (left > 0) canceled.push({ line: l.order_line_number, quantity: left, res: await cancelLine(orderId, String(l.order_line_number), left, reason) });
  }
  return { shipped: shipRes, canceled };
}

async function requeueInventoryForOrder(orderId: string) {
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  for (const l of (order?.raw as any)?.order_lines ?? []) {
    const v = (await resolveLineVariant(l).catch(() => ({} as any))).local as Variant | undefined;
    const target = v?.targetProductId ? v : l.tcin ? await db.query.variants.findFirst({ where: eq(schema.variants.tcin, String(l.tcin)) }) : null;
    if (target?.targetProductId) await enqueue('inventory', target.id);
  }
}

const pushing = new Set<string>();

/** Create the Target order in Shopify so the warehouse fulfills it there and Shopify stock decrements. Idempotent. */
export async function pushOrderToShopify(orderId: string) {
  if (pushing.has(orderId)) throw new Error('Already being created in Shopify');
  pushing.add(orderId);
  try {
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order) throw new Error('Order not found');
    if (order.shopifyOrderId) return { id: order.shopifyOrderId, name: order.shopifyOrderName, already: true };
    if (!(await shopifyWritesAllowed())) throw new Error('Creating Shopify orders from STAGE test orders is turned off (Settings › Sync & rules › allow Shopify writes on stage).');
    const raw: any = order.raw;
    const tag = `target-order-${raw.order_number ?? order.id}`;
    // already created (e.g. an earlier attempt timed out after Shopify saved it)?
    const found: any = await shopifyGraphql(ORDER_BY_TAG, { q: `tag:'${tag}'` }, 'shopify-order');
    const hit = found.orders?.nodes?.[0];
    if (hit) {
      await db.update(schema.orders).set({ shopifyOrderId: hit.id, shopifyOrderName: hit.name, shopifyPushError: null }).where(eq(schema.orders.id, orderId));
      return hit;
    }
    if (Object.keys((order.shopifyStockAdjusted ?? {}) as object).length) {
      throw new Error('Stock for this order was already deducted in Shopify directly; not creating a Shopify order to avoid deducting twice.');
    }
    const addr: any = order.address ?? (await fetchAddress(orderId));
    const sa = addr?.shipping_address ?? {};
    const lineItems: any[] = [];
    for (const l of raw.order_lines ?? []) {
      const q = soldQty(l);
      if (!q) continue;
      const r = await resolveLineVariant(l);
      if (!r.gid) throw new Error(`Line ${l.order_line_number}: no Shopify variant found for UPC ${r.barcode || '-'} / SKU ${l.external_id ?? '-'} / TCIN ${l.tcin ?? '-'}. Not created, so stock is not mixed up.`);
      lineItems.push({
        variantId: r.gid,
        quantity: q,
        priceSet: { shopMoney: { amount: String(l.unit_price ?? 0), currencyCode: raw.currency || 'USD' } },
      });
    }
    if (!lineItems.length) throw new Error('No open lines to push');
    const input = {
      order: {
        lineItems,
        poNumber: raw.order_number,
        sourceName: 'Target Plus',
        sourceIdentifier: String(order.id),
        tags: ['Target Plus', 'Target', tag],
        note: `Target Plus order ${raw.order_number} (id ${order.id}). Ship by ${raw.requested_shipment_date ?? '-'}, deliver by ${raw.requested_delivery_date ?? '-'}.`,
        financialStatus: 'PAID',
        currency: raw.currency || 'USD',
        shippingAddress: {
          firstName: sa.first_name, lastName: sa.last_name, address1: sa.address1, address2: sa.address2 || undefined,
          city: sa.city, provinceCode: sa.state, zip: sa.postal_code, countryCode: (sa.country_code || 'US').slice(0, 2).toUpperCase(),
          phone: sa.phone_numbers?.[0]?.number || undefined,
        },
        shippingLines: [{ title: raw.level_of_service ? `Target ${raw.level_of_service}` : 'Target Plus shipping', priceSet: { shopMoney: { amount: '0.00', currencyCode: raw.currency || 'USD' } } }],
      },
      options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false },
    };
    try {
      const d: any = await shopifyGraphql(ORDER_CREATE, input, 'shopify-order');
      const errs = d.orderCreate.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e: any) => e.message).join('; '));
      await db.update(schema.orders).set({ shopifyOrderId: d.orderCreate.order.id, shopifyOrderName: d.orderCreate.order.name, shopifyPushError: null }).where(eq(schema.orders.id, orderId));
      return d.orderCreate.order;
    } catch (e) {
      await db.update(schema.orders).set({ shopifyPushError: errMsg(e) }).where(eq(schema.orders.id, orderId));
      throw e;
    }
  } finally {
    pushing.delete(orderId);
  }
}

/** For orders pushed to Shopify: when Shopify has a fulfillment with tracking, send it to Target. */
/** Carrier from the tracking number when Shopify has no carrier name (UPS 1Z…, USPS 9x… 20-22 digits, FedEx 12/15/20 digits). */
export function carrierFromTracking(n: string): string {
  const x = String(n || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(x)) return 'ups';
  if (/^(94|93|92|95)\d{18,20}$/.test(x) || /^[A-Z]{2}\d{9}US$/.test(x)) return 'usps';
  if (/^\d{12}$/.test(x) || /^\d{15}$/.test(x) || /^\d{20}$/.test(x)) return 'fedex';
  return '';
}

/**
 * Shopify fulfillments → Target shipments. Runs on a timer and instantly from the fulfillments/create|update
 * webhook (only for that order). Carrier comes from Shopify's tracking company, else from the number itself.
 */
export async function syncTrackingFromShopify(opts: { shopifyOrderIds?: string[] } = {}) {
  const sync = await getSync();
  const methods = await db.select().from(schema.shippingMethods);
  const open = await db.select().from(schema.orders).where(and(inArray(schema.orders.status, OPEN), isNotNull(schema.orders.shopifyOrderId),
    ...(opts.shopifyOrderIds?.length ? [inArray(schema.orders.shopifyOrderId, opts.shopifyOrderIds)] : [])));
  let sent = 0, failed = 0;
  for (const o of open) {
    try {
      const d: any = await shopifyGraphql(ORDER_FULFILLMENTS_QUERY, { id: o.shopifyOrderId }, 'shopify-tracking');
      const done = new Set(o.shopifyTrackingSynced ?? []);
      for (const f of d.order?.fulfillments ?? []) {
        if (done.has(f.id) || f.status !== 'SUCCESS') continue;
        const t = f.trackingInfo?.[0];
        if (!t?.number) continue;
        const company = String(t.company ?? '').toLowerCase() || carrierFromTracking(t.number);
        const methodName = Object.entries(sync.carrierMap).find(([k]) => k && company.replace(/\s+/g, '').includes(k.replace(/\s+/g, '')))?.[1]
          ?? Object.entries(sync.carrierMap).find(([k]) => k === carrierFromTracking(t.number))?.[1];
        const method = methods.find((m) => m.shippingMethod === methodName);
        if (!method) throw new Error(`No Target shipping method mapped for carrier "${t.company}". Set it in Settings › Sync & rules.`);
        const fresh = await refreshOrder(o.id);
        const lines: ShipLine[] = [];
        const targetLines: any[] = (fresh!.raw as any).order_lines ?? [];
        const gidOf = new Map<string, string | undefined>();
        for (const l of targetLines) gidOf.set(l.order_line_number, (await resolveLineVariant(l).catch(() => ({} as any))).gid);
        for (const fl of f.fulfillmentLineItems?.nodes ?? []) {
          const line = targetLines.find((l: any) => (fl.lineItem?.variant?.id && gidOf.get(l.order_line_number) === fl.lineItem.variant.id) || (l.external_id && l.external_id === fl.lineItem?.sku));
          if (!line) continue;
          const q = Math.min(openQty(line), fl.quantity);
          if (q > 0) lines.push({ order_line_number: line.order_line_number, quantity: q, tracking_number: t.number, shipping_method: method.shippingMethod, shipped_date: f.createdAt });
        }
        if (lines.length) { await shipOrder(o.id, lines); sent++; }
        // mark right after Target accepted it (shipOrder only returns once the POST succeeded)
        done.add(f.id);
        await db.update(schema.orders).set({ shopifyTrackingSynced: [...done], lastError: null }).where(eq(schema.orders.id, o.id));
      }
    } catch (e) {
      failed++;
      await db.update(schema.orders).set({ lastError: errMsg(e) }).where(eq(schema.orders.id, o.id));
    }
  }
  return { ordersChecked: open.length, fulfillmentsSent: sent, failed };
}


/**
 * Target returns → Shopify: refund the returned units on the Shopify order the hub created and tag it
 * "Target return". Money is handled by Target; Shopify gets the refund record (and the units back in stock
 * when "restock returns" is on). Each Target return is processed once.
 */
export async function syncReturnsToShopify() {
  const sync = await getSync();
  if (!sync.returnsToShopify || !(await shopifyWritesAllowed())) return { skipped: true };
  const done = new Set(await getSetting<string[]>('returns.processed', []));
  const returns: any[] = await T.listReturns({}).catch(() => []);
  const shop = await getShopify();
  const restockLoc = Object.keys(shop.locationMap ?? {}).find((k) => k.startsWith('gid://shopify/Location/') && (shop.locationMap as any)[k]);
  let refunded = 0, failed = 0;
  for (const r of returns) {
    const rid = String(r.id ?? r.reference_id ?? '');
    if (!rid || done.has(rid)) continue;
    const order = r.order_id ? await db.query.orders.findFirst({ where: eq(schema.orders.id, String(r.order_id)) })
      : r.order_number ? await db.query.orders.findFirst({ where: eq(schema.orders.orderNumber, String(r.order_number)) }) : null;
    if (!order) continue; // not an order the hub knows (older than the hub)
    if (!order.shopifyOrderId) { if (await beforeCutover(order)) done.add(rid); continue; }
    try {
      const line = ((order.raw as any)?.order_lines ?? []).find((l: any) => (r.tcin && String(l.tcin) === String(r.tcin)) || (r.external_id && l.external_id === r.external_id));
      if (!line) throw new Error(`return ${rid}: no matching line on order ${order.id}`);
      const gid = (await resolveLineVariant(line)).gid;
      const d: any = await shopifyGraphql(ORDER_LINES_QUERY, { id: order.shopifyOrderId }, 'shopify-return');
      const li = (d.order?.lineItems?.nodes ?? []).find((x: any) => x.variant?.id === gid || (line.external_id && x.sku === line.external_id));
      if (!li) throw new Error(`return ${rid}: line not found in Shopify order ${order.shopifyOrderName}`);
      const qty = Math.min(Number(r.quantity || 1), li.refundableQuantity ?? li.quantity);
      if (qty > 0) {
        const restock = sync.restockReturns && restockLoc;
        const res: any = await shopifyGraphql(REFUND_CREATE, {
          input: {
            orderId: order.shopifyOrderId, notify: false,
            note: `Target Plus return ${r.reference_id ?? rid} · ${r.return_reason ?? ''}`.trim(),
            refundLineItems: [{ lineItemId: li.id, quantity: qty, restockType: restock ? 'RETURN' : 'NO_RESTOCK', ...(restock ? { locationId: restockLoc } : {}) }],
          },
        }, 'shopify-return');
        const errs = res.refundCreate?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e: any) => e.message).join('; '));
      }
      await shopifyGraphql(TAGS_ADD, { id: order.shopifyOrderId, tags: ['Target return'] }, 'shopify-return');
      done.add(rid); refunded++;
    } catch (e) {
      failed++;
      await db.update(schema.orders).set({ lastError: errMsg(e) }).where(eq(schema.orders.id, order.id));
    }
  }
  await setSetting('returns.processed', [...done].slice(-5000));
  return { returns: returns.length, refunded, failed };
}

// Typed wrappers for every Target Plus endpoint used by the hub.
// Endpoint shapes follow plus.target.com/docs/spec (seller, orders, taxonomy).
import { getActiveEnv, getTargetCreds, TargetEnvName } from '../lib/settings.js';
import { getAllPages, rawRequest, targetRequest } from './client.js';

async function sellerId(env?: TargetEnvName) {
  const creds = await getTargetCreds(env ?? (await getActiveEnv()));
  if (!creds.sellerId) throw new Error('Seller ID not configured');
  return encodeURIComponent(creds.sellerId);
}

export interface Field { name: string; value: string }
export interface ProductUpdate { external_id: string; relationship_type: 'SA' | 'VAP' | 'VC'; fields: Field[] }

// ---------------- Reports ----------------
export const REPORT_TYPES = [
  'ALLOWED_ITEM_TYPES', 'BULK_PRODUCT_DATA_TEMPLATE', 'BULK_PRODUCT_DATA', 'ITEM_ERRORS', 'ITEM_ERRORS_V2', 'ORDERS',
  'INVENTORY', 'RETURN_ORDERS_EXTERNAL', 'PARTNER_RETURN_POLICIES', 'PRODUCT_LOGISTIC_ERRORS', 'PAYOUT_RECONCILIATION',
  'ATTRIBUTE_VALUES', 'ORDERS_PAST_SLA', 'ORDER_DEFECTS', 'SALES_METRICS', 'ITEM_INCONSISTENCIES',
] as const;

export async function createReport(body: { type: string; format?: string; start_date?: string; end_date?: string; parameters?: Record<string, any> }, source = 'reports') {
  return (await targetRequest('sellers', 'POST', `/sellers/${await sellerId()}/report_requests`, { body: { format: 'JSON', ...body }, source })).data;
}
export async function listReports(query: { type?: string; page?: number; per_page?: number } = {}) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/report_requests`, { query: { per_page: 50, ...query }, source: 'reports' })).data;
}
export async function getReport(id: string) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/report_requests/${encodeURIComponent(id)}`, { source: 'reports' })).data;
}
export async function cancelReport(id: string) {
  return (await targetRequest('sellers', 'DELETE', `/sellers/${await sellerId()}/report_requests/${encodeURIComponent(id)}`, { source: 'reports' })).status;
}
export async function downloadReport(downloadUrl: string) {
  const env = await getActiveEnv();
  const r = await rawRequest(env, 'GET', downloadUrl, { forDownload: true, accept: '*/*', source: 'report-download' });
  return { data: r.data, contentType: r.headers.get('content-type') ?? '' };
}

// ---------------- Taxonomy ----------------
export async function getAssignments(taxonomyId: string) {
  return getAllPages('taxonomy', '/assignments', {
    taxonomy_id: taxonomyId, attribute_group: 'SELLING,CORE,TAX,LOGISTICS', target: 'EXTERNAL',
  }, { perPage: 1000, source: 'taxonomy' });
}
export async function getAttributeValues(taxonomyId: string, attributeId: string) {
  return getAllPages('taxonomy', '/attribute_values', { taxonomy_id: taxonomyId, attribute_id: attributeId, target: 'EXTERNAL' }, { perPage: 1000, source: 'taxonomy-values' });
}
export async function getTaxonomy(id: string) {
  return (await targetRequest('taxonomy', 'GET', `/taxonomies/${encodeURIComponent(id)}`, { source: 'taxonomy' })).data;
}
/**
 * Find item types by name. The kickoff doc uses /taxonomies, the guide /taxonomy; the "name" filter may be ignored.
 * Tries both paths, then falls back to reading every ITEM_TYPE page once (cached) and filtering here.
 */
let itemTypeCache: { at: number; list: any[] } | null = null;
const listOf = (d: any): any[] => (Array.isArray(d) ? d : d?.data ?? d?.items ?? d?.taxonomies ?? []);
export async function searchItemTypes(name: string) {
  const q = name.trim().toLowerCase();
  const match = (list: any[]) => list.filter((t) => String(t.name ?? '').toLowerCase().includes(q));
  for (const path of ['/taxonomies', '/taxonomy']) {
    try {
      const d = (await targetRequest('taxonomy', 'GET', path, { query: { type: 'ITEM_TYPE', target: 'EXTERNAL', name, per_page: 100 }, source: 'taxonomy-search', retries: 1 })).data;
      const hits = match(listOf(d));
      if (hits.length) return hits;
    } catch { /* try the next way */ }
  }
  if (!itemTypeCache || Date.now() - itemTypeCache.at > 6 * 3600e3) {
    let all: any[] = [];
    for (const path of ['/taxonomies', '/taxonomy']) {
      try { all = await getAllPages('taxonomy', path, { type: 'ITEM_TYPE', target: 'EXTERNAL' }, { perPage: 1000, maxPages: 50, source: 'taxonomy-search' }); } catch { all = []; }
      if (all.length) break;
    }
    if (!all.length) throw new Error('Target taxonomy search did not answer. Add the category by its item type ID instead (ask Target for the ID).');
    itemTypeCache = { at: Date.now(), list: all.filter((t) => !t.type || String(t.type).toUpperCase() === 'ITEM_TYPE') };
  }
  return match(itemTypeCache.list).slice(0, 100);
}

// ---------------- Seller setup ----------------
export async function getDistributionCenters() {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/distribution_centers`, { source: 'setup' })).data;
}
export async function getShippingMethods() {
  return getAllPages('orders', '/shipping_methods', {}, { perPage: 100, source: 'setup' });
}
export async function getReturnPolicies() {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/return_policies`, { source: 'setup' })).data;
}
export async function getLegalizations(type?: 'ITEM_TYPE' | 'BRAND') {
  return getAllPages('sellers', `/sellers/${await sellerId()}/legalizations`, { type }, { perPage: 100, source: 'setup' });
}

// ---------------- Products ----------------
export async function createProduct(p: ProductUpdate) {
  return (await targetRequest('sellers', 'POST', `/sellers/${await sellerId()}/products`, { body: p, source: 'items', nonIdempotent: true })).data;
}
export async function createOrUpdateVariationFamily(body: { parent: ProductUpdate; children: ProductUpdate[] }) {
  return (await targetRequest('sellers', 'POST', `/sellers/${await sellerId()}/product_variation_update`, { body, source: 'items', nonIdempotent: true })).data;
}
export async function updateProduct(productId: string, p: ProductUpdate) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}`, { body: p, source: 'items' })).data;
}
export async function getProduct(productId: string) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}`, { query: { expand: 'fields,product_statuses' }, source: 'items' })).data;
}
export async function unlistProduct(productId: string) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}:unlist`, { body: { listing_status: 'UNLISTED' }, source: 'items' })).data;
}
export async function unlistByStatus(productId: string, statusId: string) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}/statuses/${encodeURIComponent(statusId)}`, { body: { listing_status: 'UNLISTED' }, source: 'items' })).data;
}
/** Full catalog via after_id pagination. */
export async function getCatalog(query: { listing_status?: string; external_id?: string; tcin?: string; expand?: string } = {}) {
  const sid = await sellerId();
  const out: any[] = [];
  let afterId: string | undefined;
  for (let i = 0; i < 500; i++) {
    const r = await targetRequest<any[]>('sellers', 'GET', `/sellers/${sid}/products_catalog`, {
      query: { per_page: 1000, expand: 'product_statuses', ...query, after_id: afterId }, source: 'catalog',
    });
    const items = Array.isArray(r.data) ? r.data : [];
    if (!items.length) break;
    out.push(...items);
    const last = items[items.length - 1].id;
    if (!last || last === afterId) break;
    afterId = last;
  }
  return out;
}
export async function getCatalogErrors(query: { error_severity?: string; listing_status?: string; tcin?: string; externalIds?: string } = {}) {
  const sid = await sellerId();
  const out: any[] = [];
  let afterId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await targetRequest<any[]>('sellers', 'GET', `/sellers/${sid}/product_catalog_errors`, { query: { ...query, after_id: afterId }, source: 'errors' });
    const items = Array.isArray(r.data) ? r.data : [];
    if (!items.length) break;
    out.push(...items);
    const last = items[items.length - 1]?.id;
    if (!last || last === afterId) break;
    afterId = last;
  }
  return out;
}

// ---------------- Price / inventory / logistics ----------------
export async function getPrice(productId: string) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/prices/${encodeURIComponent(productId)}`, { source: 'price' })).data;
}
export async function setPrice(productId: string, price: { list_price: number; offer_price?: number; map_price?: number }) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/prices/${encodeURIComponent(productId)}`, { body: price, source: 'price' })).data;
}
export async function getQuantities(productId: string) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}/quantities`, { source: 'inventory' })).data;
}
export async function setQuantity(productId: string, dcId: string, quantity: number) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/products/${encodeURIComponent(productId)}/quantities/${encodeURIComponent(dcId)}`, { body: { quantity }, source: 'inventory' })).data;
}
export async function getLogistics(productId: string) {
  return (await targetRequest('sellers', 'GET', `/sellers/${await sellerId()}/product_logistics/${encodeURIComponent(productId)}`, { source: 'logistics' })).data;
}
export async function setLogistics(productId: string, fields: Field[]) {
  return (await targetRequest('sellers', 'PUT', `/sellers/${await sellerId()}/product_logistics/${encodeURIComponent(productId)}`, { body: { fields }, source: 'logistics' })).data;
}

// ---------------- Orders ----------------
export async function listOrders(query: { order_status?: string; order_number?: string; order_date?: string } = {}) {
  return getAllPages('orders', `/sellers/${await sellerId()}/orders`, query, { perPage: 100, source: 'orders' });
}
export async function getOrder(orderId: string) {
  return (await targetRequest('orders', 'GET', `/sellers/${await sellerId()}/orders/${encodeURIComponent(orderId)}`, { source: 'orders' })).data;
}
export async function getOrderAddress(orderId: string) {
  return (await targetRequest('orders', 'GET', `/sellers/${await sellerId()}/order_addresses/${encodeURIComponent(orderId)}`, { source: 'orders', hideResponse: true })).data;
}
export async function setOrderStatus(orderId: string, status: string) {
  return (await targetRequest('orders', 'PUT', `/sellers/${await sellerId()}/order_statuses/${encodeURIComponent(orderId)}`, { body: { status }, source: 'orders' })).data;
}
export interface FulfillmentItem { order_line_number: string; quantity: number; shipped_date: string; shipping_method: string; tracking_number: string; level_of_service?: string }
export async function createFulfillments(orderId: string, items: FulfillmentItem[]) {
  return (await targetRequest('orders', 'POST', `/sellers/${await sellerId()}/orders/${encodeURIComponent(orderId)}/bulk_fulfillments_create`, { body: { items }, source: 'orders', nonIdempotent: true })).data;
}
export async function updateFulfillments(orderId: string, items: (FulfillmentItem & { id: string })[]) {
  return (await targetRequest('orders', 'PUT', `/sellers/${await sellerId()}/orders/${encodeURIComponent(orderId)}/bulk_fulfillments_update`, { body: { items }, source: 'orders' })).data;
}
export async function getFulfillments(orderId: string) {
  return (await targetRequest('orders', 'GET', `/sellers/${await sellerId()}/orders/${encodeURIComponent(orderId)}/fulfillments`, { source: 'orders' })).data;
}
export async function updateOrderLine(orderId: string, lineId: string, body: { cancellation_reason?: string; order_line_statuses: { status: string; quantity: number }[] }) {
  return (await targetRequest('orders', 'PUT', `/sellers/${await sellerId()}/orders/${encodeURIComponent(orderId)}/order_lines/${encodeURIComponent(lineId)}`, { body, source: 'orders' })).data;
}

// ---------------- Returns ----------------
export async function listReturns(query: { order_id?: string; order_number?: string; tcin?: string } = {}) {
  return getAllPages('sellers', `/sellers/${await sellerId()}/product_returns`, query, { perPage: 100, maxPages: 20, source: 'returns' });
}
export async function listReturnDisputes() {
  return getAllPages('sellers', `/sellers/${await sellerId()}/return_disputes`, {}, { perPage: 100, maxPages: 10, source: 'returns' });
}

export const CANCELLATION_REASONS = [
  'ITEM_NOT_AVAILABLE', 'COULD_NOT_SHIP', 'SHIPPING_ADDRESS_UNDELIVERABLE', 'BUYER_CANCELED', 'GENERAL_ADJUSTMENT',
  'ALTERNATE_ITEM_PROVIDED', 'MERCHANDISE_NOT_RECEIVED', 'CUSTOMER_RETURNED_ITEM', 'CUSTOMER_EXCHANGE', 'OTHER',
];

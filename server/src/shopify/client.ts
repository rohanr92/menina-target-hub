// Shopify Admin GraphQL client + the operations the hub needs.
// All operations validated against the Shopify Admin schema.
import { logApi } from '../lib/apilog.js';
import { getShopify } from '../lib/settings.js';

export const DEFAULT_SHOPIFY_API_VERSION = '2025-07';

export class ShopifyError extends Error {
  constructor(message: string, public details?: any) { super(message); }
}

export function normalizeShopDomain(input: string): string {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d.startsWith('admin.shopify.com')) throw new ShopifyError('Use your *.myshopify.com domain, e.g. your-store.myshopify.com');
  if (!d.includes('.')) d += '.myshopify.com';
  return d;
}

export async function shopifyGraphql<T = any>(query: string, variables: Record<string, any> = {}, source = 'shopify'): Promise<T> {
  const s = await getShopify();
  if (!s.shopDomain || !s.accessToken) throw new ShopifyError('Shopify is not connected. Add the store domain and Admin API token in Settings.');
  // SHOPIFY_API_BASE is only for local testing against a mock server
  const url = `${process.env.SHOPIFY_API_BASE || `https://${s.shopDomain}`}/admin/api/${s.apiVersion || DEFAULT_SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': s.accessToken },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = null; }
    const throttled = res.status === 429 || json?.errors?.some?.((e: any) => e?.extensions?.code === 'THROTTLED');
    await logApi({
      service: 'shopify', method: 'POST', url, status: res.status, durationMs: Date.now() - started,
      requestBody: JSON.stringify({ op: query.match(/(query|mutation)\s+(\w+)/)?.[2], variables }).slice(0, 4000),
      responseBody: res.ok && !json?.errors ? `[ok ${text.length} bytes]` : text, source,
    });
    if (throttled && attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue; }
    if (!res.ok) throw new ShopifyError(`Shopify ${res.status}: ${text.slice(0, 300)}`);
    if (json?.errors?.length) throw new ShopifyError('Shopify GraphQL error: ' + json.errors.map((e: any) => e.message).join('; '), json.errors);
    return json.data as T;
  }
}

const VARIANT_FIELDS = `
  id sku barcode title price compareAtPrice
  selectedOptions { name value }
  media(first: 1) { nodes { ... on MediaImage { image { url } } } }
  inventoryItem {
    id
    measurement { weight { unit value } }
    inventoryLevels(first: 20) { nodes { location { id name } quantities(names: ["available"]) { name quantity } } }
  }`;

export const PRODUCTS_QUERY = `
query Products($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title descriptionHtml vendor productType tags status
      options { name position }
      media(first: 20) { nodes { ... on MediaImage { image { url } } } }
      variants(first: 100) { nodes { ${VARIANT_FIELDS} } }
    }
  }
}`;

export const VARIANTS_BY_CODE = `query VariantsByCode($q: String!, $after: String) { productVariants(first: 100, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id sku barcode product { id } } } }`;

export const PRODUCTS_BY_IDS = `
query ProductsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id handle title descriptionHtml vendor productType tags status
      options { name position }
      media(first: 20) { nodes { ... on MediaImage { image { url } } } }
      variants(first: 100) { nodes { ${VARIANT_FIELDS} } }
    }
  }
}`;

export const VARIANT_STOCK_QUERY = `
query VariantStock($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id sku price compareAtPrice
      inventoryItem { id inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { name quantity } } } }
    }
  }
}`;

export const SHOP_QUERY = `query Locations { shop { name myshopifyDomain currencyCode } locations(first: 50) { nodes { id name isActive } } }`;

export const ORDER_CREATE = `
mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name }
    userErrors { field message }
  }
}`;

export const ORDER_FULFILLMENTS_QUERY = `
query OrderFulfillments($id: ID!) {
  order(id: $id) {
    id name displayFulfillmentStatus cancelledAt
    fulfillments(first: 20) {
      id createdAt status
      trackingInfo { company number url }
      fulfillmentLineItems(first: 50) { nodes { quantity lineItem { sku variant { id } } } }
    }
  }
}`;

export const INVENTORY_ADJUST = `
mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) {
    inventoryAdjustmentGroup { id }
    userErrors { field message }
  }
}`;

export const ORDER_BY_TAG = `query OrderByTag($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;

export const VARIANT_BY_SKU = `query VariantBySku($q: String!) { productVariants(first: 5, query: $q) { nodes { id sku product { id } } } }`;

export function availableAt(levels: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of levels?.nodes ?? []) {
    const q = l.quantities?.find((x: any) => x.name === 'available')?.quantity ?? 0;
    out[l.location.id] = q;
  }
  return out;
}

export function weightToLb(w?: { unit: string; value: number } | null): number | null {
  if (!w || w.value == null) return null;
  const v = Number(w.value);
  switch (w.unit) {
    case 'POUNDS': return v;
    case 'OUNCES': return v / 16;
    case 'KILOGRAMS': return v * 2.20462;
    case 'GRAMS': return v / 453.592;
    default: return v;
  }
}

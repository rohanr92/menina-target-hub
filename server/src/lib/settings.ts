import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { decrypt, encrypt } from './crypto.js';

export type TargetEnvName = 'stage' | 'production';

export interface TargetCredentials {
  apiKey?: string;
  sellerId?: string;
  sellerToken?: string;
  tgtrt?: string; // stage only: report download header
  authMode?: 'seller_token' | 'oauth' | 'both';
  hostOverride?: string; // default stage-api.target.com / api.target.com
  returnPolicy?: string; // e.g. AAC
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // epoch ms
    pendingState?: string;
    pendingNonce?: string;
  };
}

export interface ShopifySettings {
  shopDomain?: string; // menina-step-handcrafted-in-spain.myshopify.com
  accessToken?: string; // Admin API access token (shpat_...)
  apiVersion?: string;
  webhookSecret?: string; // app client secret, for HMAC verification
  locationMap?: Record<string, string>; // shopify location gid -> Target distribution_center_id
  importQuery?: string; // Shopify product search query used for import
}

export interface HubSettings {
  url?: string; // Marketplace Hub export endpoint returning products JSON
  token?: string;
}

export interface SyncSettings {
  inventoryEnabled: boolean;
  priceEnabled: boolean;
  inventoryIntervalMin: number;
  ordersEnabled: boolean;
  ordersIntervalMin: number;
  statusIntervalMin: number;
  autoAcknowledge: boolean;
  pushOrdersToShopify: boolean;
  deductShopifyStock: boolean; // when orders are not pushed: take sold units out of Shopify stock
  syncTrackingFromShopify: boolean;
  requestsPerSecond: number;
  safetyStock: number;
  maxQtyPerItem: number | null;
  reserveOpenOrders: boolean;
  /** orders dated before this moment were handled by the old integration: never created in Shopify, never reserve stock */
  ordersCutoverAt: string | null;
  /** Target returns: refund the hub-created Shopify order (and tag it) */
  returnsToShopify: boolean;
  /** put returned units back in Shopify stock when refunding */
  restockReturns: boolean;
  price: {
    listFrom: 'compare_at_or_price' | 'price';
    offerFrom: 'price' | 'none';
    mapFrom: 'none' | 'price';
    multiplier: number;
    roundTo99: boolean;
  };
  stage: { forceBrand: string; useMockBarcodes: boolean; allowShopifyWrites: boolean };
  defaultLogistics: { is_add_on: string; two_day_shipping_eligible: string; shipping_exclusion: string; seller_return_policy: string };
  carrierMap: Record<string, string>; // shopify tracking company (lowercase) -> Target shipping_method
  parentSkuPattern: string; // template for VAP external_id
  /** Target title rules. Tokens: {brand} {audience} {name} {color} {size} {us} {eu}; [ … ] = left out when a token inside is empty */
  titles: { child: string; standalone: string; parent: string; audience: string; sizeChart: string };
  /** Shopify size value -> value sent as child_variations.size (learned from your existing Target items) */
  sizeValues: Record<string, string>;
}

export const defaultSync: SyncSettings = {
  inventoryEnabled: true,
  priceEnabled: true,
  inventoryIntervalMin: 30,
  ordersEnabled: false,
  ordersIntervalMin: 15,
  statusIntervalMin: 15,
  autoAcknowledge: true,
  pushOrdersToShopify: false,
  deductShopifyStock: false,
  syncTrackingFromShopify: false,
  requestsPerSecond: 2,
  safetyStock: 0,
  maxQtyPerItem: null,
  reserveOpenOrders: true,
  ordersCutoverAt: null,
  returnsToShopify: true,
  restockReturns: false,
  price: { listFrom: 'compare_at_or_price', offerFrom: 'price', mapFrom: 'none', multiplier: 1, roundTo99: false },
  stage: { forceBrand: 'Valor Fitness', useMockBarcodes: true, allowShopifyWrites: false },
  defaultLogistics: { is_add_on: 'No', two_day_shipping_eligible: 'No', shipping_exclusion: 'No', seller_return_policy: '' },
  carrierMap: { ups: 'UPSGround', fedex: 'FedExGround', usps: 'USPSGroundAdvantage' },
  parentSkuPattern: 'VAP-{handle}',
  sizeValues: {},
  titles: {
    child: '{brand} {audience} {name} {color}[ {us} US / {eu} EU]',
    standalone: '{brand} {audience} {name}[ {color}][ {us} US / {eu} EU]',
    parent: '{brand} {audience} {name}',
    audience: "Women's",
    sizeChart: '34=4, 35=5, 36=6, 37=7, 38=8, 39=9, 40=10, 41=11, 42=12, 43=13',
  },
};

const cache = new Map<string, any>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  if (cache.has(key)) return cache.get(key);
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  let val: T = fallback;
  if (row) {
    try { val = JSON.parse(decrypt(row.value)); } catch { val = fallback; }
  }
  cache.set(key, val);
  return val;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const enc = encrypt(JSON.stringify(value));
  await db.insert(schema.settings).values({ key, value: enc })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: enc, updatedAt: new Date() } });
  cache.set(key, value);
}

export async function getActiveEnv(): Promise<TargetEnvName> {
  return getSetting<TargetEnvName>('target.activeEnv', 'stage');
}

export async function getTargetCreds(envName?: TargetEnvName): Promise<TargetCredentials> {
  const e = envName ?? (await getActiveEnv());
  return getSetting<TargetCredentials>(`target.${e}`, {});
}

export async function getSync(): Promise<SyncSettings> {
  const s = await getSetting<Partial<SyncSettings>>('sync', {});
  return {
    ...defaultSync, ...s,
    price: { ...defaultSync.price, ...(s.price ?? {}) },
    stage: { ...defaultSync.stage, ...(s.stage ?? {}) },
    defaultLogistics: { ...defaultSync.defaultLogistics, ...(s.defaultLogistics ?? {}) },
    carrierMap: { ...defaultSync.carrierMap, ...(s.carrierMap ?? {}) },
    titles: { ...defaultSync.titles, ...(s.titles ?? {}) },
  };
}

export async function getShopify(): Promise<ShopifySettings> {
  return getSetting<ShopifySettings>('shopify', {});
}

/** Replace secret values with a masked preview for the UI. */
export function mask(v?: string): string {
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return v.slice(0, 4) + '••••' + v.slice(-4);
}

// MeninaTargetHub database schema (Drizzle ORM + Postgres)
import {
  pgTable, text, integer, boolean, timestamp, jsonb, serial, doublePrecision, numeric,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';

const id = () => text('id').primaryKey().$defaultFn(createId);
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());

// Encrypted key/value settings (API keys, tokens, sync rules)
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // AES-256-GCM encrypted JSON
  updatedAt: updated(),
});

// Every call made to Target / Shopify (secrets redacted)
export const apiLogs = pgTable('api_logs', {
  id: serial('id').primaryKey(),
  createdAt: created(),
  service: text('service').notNull(), // target | shopify
  env: text('env'),
  method: text('method').notNull(),
  url: text('url').notNull(),
  status: integer('status'),
  durationMs: integer('duration_ms'),
  requestBody: text('request_body'),
  responseBody: text('response_body'),
  error: text('error'),
  source: text('source'),
}, (t) => [index('api_logs_created_idx').on(t.createdAt), index('api_logs_status_idx').on(t.service, t.status)]);

export const itemTypes = pgTable('item_types', {
  id: text('id').primaryKey(), // taxonomy id of the item type
  name: text('name').notNull(),
  raw: jsonb('raw'),
  attributesFetchedAt: timestamp('attributes_fetched_at', { withTimezone: true }),
  valuesFetchedAt: timestamp('values_fetched_at', { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
});

export const attributes = pgTable('attributes', {
  id: id(),
  itemTypeId: text('item_type_id').notNull().references(() => itemTypes.id, { onDelete: 'cascade' }),
  attributeId: text('attribute_id').notNull(),
  taxonomyId: text('taxonomy_id').notNull(), // "root" for CORE attributes, else item type id
  name: text('name').notNull(),
  mappedProperty: text('mapped_property'),
  type: text('type').notNull(), // TEXT | VALUE | MEASURE | NUMBER | INTEGER
  group: text('attr_group').notNull(), // SELLING | CORE | TAX | LOGISTICS
  required: boolean('required').notNull().default(false),
  maxSelections: integer('max_selections').notNull().default(1),
  description: text('description'),
  raw: jsonb('raw'),
  valuesFetched: boolean('values_fetched').notNull().default(false),
}, (t) => [uniqueIndex('attributes_type_attr_uq').on(t.itemTypeId, t.attributeId)]);

export const attributeValues = pgTable('attribute_values', {
  id: id(),
  attrId: text('attr_id').notNull().references(() => attributes.id, { onDelete: 'cascade' }),
  valueId: text('value_id').notNull(),
  name: text('name').notNull(),
}, (t) => [uniqueIndex('attribute_values_uq').on(t.attrId, t.valueId)]);

export const distributionCenters = pgTable('distribution_centers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  raw: jsonb('raw'),
  updatedAt: updated(),
});

export const shippingMethods = pgTable('shipping_methods', {
  id: text('id').primaryKey(),
  shippingMethod: text('shipping_method').notNull(),
  carrier: text('carrier').notNull(),
  scac: text('scac').notNull(),
  serviceCode: text('service_code').notNull(),
  raw: jsonb('raw'),
  updatedAt: updated(),
});

// Per item type: how product data maps onto Target attributes
export const mappingProfiles = pgTable('mapping_profiles', {
  itemTypeId: text('item_type_id').primaryKey(),
  rules: jsonb('rules').notNull().default([]),
  updatedAt: updated(),
});

// Source product = a Target SA item or a VAP (parent) family
export const products = pgTable('products', {
  id: id(),
  source: text('source').notNull().default('shopify'), // shopify | hub | file
  sourceId: text('source_id').notNull().unique(),
  handle: text('handle'),
  title: text('title').notNull(),
  descriptionHtml: text('description_html'),
  vendor: text('vendor'),
  productType: text('product_type'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  images: jsonb('images').$type<string[]>().notNull().default([]),
  optionNames: jsonb('option_names').$type<string[]>().notNull().default([]),
  shopifyStatus: text('shopify_status'),
  itemTypeId: text('item_type_id'),
  theme: text('theme'), // SA | size | color | size and color (null = auto)
  sizeOption: text('size_option'),
  colorOption: text('color_option'),
  bullets: jsonb('bullets').$type<string[]>().notNull().default([]),
  overrides: jsonb('overrides').$type<Record<string, any>>().notNull().default({}),
  parentExternalId: text('parent_external_id'),
  targetParentId: text('target_parent_id'),
  targetParentTcin: text('target_parent_tcin'),
  parentStatus: text('parent_status'),
  parentValidation: text('parent_validation'),
  parentErrors: jsonb('parent_errors'),
  logistics: jsonb('logistics').$type<Record<string, string> | null>(),
  enabled: boolean('enabled').notNull().default(true),
  lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
  lastPushError: text('last_push_error'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index('products_item_type_idx').on(t.itemTypeId)]);

export const variants = pgTable('variants', {
  id: id(),
  productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().unique(),
  inventoryItemId: text('inventory_item_id'),
  sku: text('sku'),
  barcode: text('barcode'),
  mockBarcode: text('mock_barcode'), // valid-checksum barcode used on STAGE
  title: text('title'),
  price: numeric('price', { precision: 10, scale: 2 }),
  compareAtPrice: numeric('compare_at_price', { precision: 10, scale: 2 }),
  options: jsonb('options').$type<Record<string, string>>().notNull().default({}),
  weightLb: doublePrecision('weight_lb'),
  imageUrl: text('image_url'),
  inventory: integer('inventory').notNull().default(0),
  inventoryByLoc: jsonb('inventory_by_loc').$type<Record<string, number>>().notNull().default({}),
  overrides: jsonb('overrides').$type<Record<string, any>>().notNull().default({}),
  syncEnabled: boolean('sync_enabled').notNull().default(true),
  targetProductId: text('target_product_id'),
  tcin: text('tcin'),
  listingStatus: text('listing_status'),
  validationStatus: text('validation_status'),
  errors: jsonb('errors'),
  lastPriceSent: jsonb('last_price_sent'),
  lastQtySent: jsonb('last_qty_sent').$type<Record<string, number> | null>(),
  lastPriceSentAt: timestamp('last_price_sent_at', { withTimezone: true }),
  lastQtySentAt: timestamp('last_qty_sent_at', { withTimezone: true }),
  statusCheckedAt: timestamp('status_checked_at', { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index('variants_sku_idx').on(t.sku), index('variants_target_idx').on(t.targetProductId)]);

// Durable work queue for price / inventory / logistics pushes (coalesced per item)
export const syncTasks = pgTable('sync_tasks', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(), // price | inventory | logistics
  variantId: text('variant_id'),
  productId: text('product_id'),
  dedupKey: text('dedup_key').unique(),
  status: text('status').notNull().default('pending'), // pending | running | done | failed
  rerun: boolean('rerun').notNull().default(false), // a newer change arrived while running
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  result: jsonb('result'),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index('sync_tasks_status_idx').on(t.status, t.runAfter)]);

export const orders = pgTable('orders', {
  id: text('id').primaryKey(), // Target order id
  orderNumber: text('order_number'),
  status: text('status').notNull(),
  orderDate: timestamp('order_date', { withTimezone: true }),
  requestedShipmentDate: timestamp('requested_shipment_date', { withTimezone: true }),
  requestedDeliveryDate: timestamp('requested_delivery_date', { withTimezone: true }),
  raw: jsonb('raw').notNull(),
  address: jsonb('address'),
  fulfillments: jsonb('fulfillments'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  shopifyOrderId: text('shopify_order_id'),
  shopifyOrderName: text('shopify_order_name'),
  shopifyPushError: text('shopify_push_error'),
  shopifyTrackingSynced: jsonb('shopify_tracking_synced').$type<string[]>().notNull().default([]),
  shopifyStockAdjusted: jsonb('shopify_stock_adjusted').$type<Record<string, number>>().notNull().default({}), // sku -> units taken out of Shopify stock
  lastError: text('last_error'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index('orders_status_idx').on(t.status)]);

export const reportRequests = pgTable('report_requests', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  format: text('format'),
  status: text('status').notNull(),
  downloadUrl: text('download_url'),
  params: jsonb('params'),
  raw: jsonb('raw'),
  createdAt: created(),
  updatedAt: updated(),
});

export const testScenarios = pgTable('test_scenarios', {
  id: text('id').primaryKey(), // "<sheet>|<scenario>"
  sheet: text('sheet').notNull(),
  scenario: text('scenario').notNull(),
  section: text('section').notNull(),
  owner: text('owner').notNull(),
  description: text('description').notNull(),
  identifiers: text('identifiers').notNull().default(''),
  hint: text('hint').notNull().default(''),
  notes: text('notes').notNull().default(''),
  status: text('status').notNull().default(''),
  date: timestamp('date', { withTimezone: true }),
  sort: integer('sort').notNull(),
  updatedAt: updated(),
});

export const jobRuns = pgTable('job_runs', {
  id: serial('id').primaryKey(),
  job: text('job').notNull(),
  status: text('status').notNull(), // running | ok | error
  message: text('message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('job_runs_idx').on(t.job, t.startedAt)]);

export type Product = typeof products.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type Attribute = typeof attributes.$inferSelect;
export type Order = typeof orders.$inferSelect;

// Items that exist on Target (pulled from products_catalog), matched to Shopify variants by UPC or SKU
export const targetItems = pgTable('target_items', {
  id: text('id').primaryKey(), // Target product_id
  env: text('env').notNull(),
  tcin: text('tcin'),
  externalId: text('external_id'),
  relationshipType: text('relationship_type'),
  parentId: text('parent_id'),
  barcode: text('barcode'),
  title: text('title'),
  itemTypeName: text('item_type_name'),
  listingStatus: text('listing_status'),
  validationStatus: text('validation_status'),
  fields: jsonb('fields').$type<{ name: string; value: string }[]>().notNull().default([]),
  matchedVariantId: text('matched_variant_id'),
  matchedProductId: text('matched_product_id'),
  matchBy: text('match_by'), // upc | sku | parent
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('target_items_barcode_idx').on(t.barcode), index('target_items_ext_idx').on(t.externalId)]);

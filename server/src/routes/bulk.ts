import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../lib/env.js';
import { getShopify, getSync } from '../lib/settings.js';
import { shopifyGraphql } from '../shopify/client.js';
import { unlistVariant } from '../services/items.js';
import { enqueue } from '../services/sync.js';
import { adoptAllTargetData, adoptProgress, autoItemTypesFromTarget } from '../services/targetCatalog.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

const WEBHOOK_LIST = `query Hooks { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`;
const WEBHOOK_LIST_OLD = `query Hooks { webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`;
const WEBHOOK_CREATE = `mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`;
const TOPICS = ['INVENTORY_LEVELS_UPDATE', 'PRODUCTS_UPDATE', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE'];

async function listHooks(): Promise<{ id: string; topic: string; url: string }[]> {
  try {
    const d: any = await shopifyGraphql(WEBHOOK_LIST, {}, 'shopify-webhooks');
    return (d.webhookSubscriptions?.nodes ?? []).map((n: any) => ({ id: n.id, topic: n.topic, url: n.uri }));
  } catch {
    const d: any = await shopifyGraphql(WEBHOOK_LIST_OLD, {}, 'shopify-webhooks');
    return (d.webhookSubscriptions?.nodes ?? []).map((n: any) => ({ id: n.id, topic: n.topic, url: n.endpoint?.callbackUrl }));
  }
}

/** Variant ids for a bulk action: explicit SKUs, or every SKU of the given products. */
async function idsFrom(b: any): Promise<string[]> {
  const ids = new Set<string>((b?.variantIds ?? []).map(String));
  if (b?.productIds?.length) for (const v of await db.select({ id: schema.variants.id }).from(schema.variants).where(inArray(schema.variants.productId, b.productIds))) ids.add(v.id);
  if (!ids.size) throw bad('Select at least one SKU');
  return [...ids];
}

async function setOverride(ids: string[], patch: (ov: Record<string, any>) => Record<string, any>) {
  const vs = await db.select().from(schema.variants).where(inArray(schema.variants.id, ids));
  for (const v of vs) await db.update(schema.variants).set({ overrides: patch({ ...((v.overrides as any) ?? {}) }) }).where(eq(schema.variants.id, v.id));
  return vs;
}

export default async function (app: FastifyInstance) {
  // ---------- instant stock / price sync: Shopify webhooks ----------
  app.get('/api/shopify/webhooks', async (req) => {
    const shop = await getShopify();
    const url = `${env.publicUrl || `https://${req.headers.host}`}/api/webhooks/shopify`;
    if (!shop.accessToken) return { url, hooks: [], ready: false, hasSecret: !!shop.webhookSecret };
    const hooks = await listHooks().catch((e) => { throw bad(`Could not read Shopify webhooks: ${e?.message ?? e}`); });
    const ours = hooks.filter((h) => h.url === url);
    return { url, hasSecret: !!shop.webhookSecret, hooks: ours, missing: TOPICS.filter((t) => !ours.some((h) => h.topic === t)) };
  });
  app.post('/api/shopify/webhooks/register', async (req) => {
    const shop = await getShopify();
    if (!shop.accessToken) throw bad('Connect Shopify first');
    if (!shop.webhookSecret) throw bad('Paste your Shopify app’s client secret in “Webhook signing secret” and Save first (Shopify signs webhooks with it).');
    const url = `${env.publicUrl || `https://${req.headers.host}`}/api/webhooks/shopify`;
    const have = await listHooks();
    const out: any[] = [];
    for (const topic of TOPICS) {
      if (have.some((h) => h.topic === topic && h.url === url)) { out.push({ topic, status: 'already registered' }); continue; }
      let d: any;
      try { d = await shopifyGraphql(WEBHOOK_CREATE, { topic, sub: { uri: url, format: 'JSON' } }, 'shopify-webhooks'); }
      catch { d = await shopifyGraphql(WEBHOOK_CREATE, { topic, sub: { callbackUrl: url, format: 'JSON' } }, 'shopify-webhooks'); }
      const errs = d.webhookSubscriptionCreate?.userErrors ?? [];
      out.push({ topic, status: errs.length ? `failed: ${errs.map((e: any) => e.message).join('; ')}` : 'registered' });
    }
    return { url, results: out };
  });

  app.post('/api/settings/learn-sizes', async (req) => {
    const r = await learnSizes();
    if ((req.body as any)?.save) {
      const { getSetting, setSetting } = await import('../lib/settings.js');
      const cur = await getSetting<any>('sync', {});
      await setSetting('sync', { ...cur, sizeValues: r.sizeValues, titles: { ...(cur.titles ?? {}), ...(r.chart ? { sizeChart: r.chart } : {}) } });
    }
    return r;
  });

  // ---------- existing items: copy Target's data into the hub ----------
  app.post('/api/target-catalog/adopt', async (req) => adoptAllTargetData({ force: !!(req.body as any)?.force }));
  app.get('/api/target-catalog/adopt', async () => adoptProgress);

  app.post('/api/products/item-types-from-target', async () => autoItemTypesFromTarget());

  // ---------- bulk actions on SKUs (Price & inventory page, product page) ----------
  /** Buffer = units held back from Target for these SKUs (empty/null = use the global buffer). */
  app.post('/api/bulk/buffer', async (req) => {
    const b = req.body as any;
    const ids = await idsFrom(b);
    const val = b.buffer === null || b.buffer === '' || b.buffer === undefined ? null : Math.max(0, Math.floor(Number(b.buffer)));
    if (val !== null && !Number.isFinite(val)) throw bad('Buffer must be a number');
    await setOverride(ids, (ov) => { if (val === null) delete ov._buffer; else ov._buffer = val; return ov; });
    for (const id of ids) await enqueue('inventory', id, { force: true });
    return { updated: ids.length, buffer: val };
  });

  /** Stop selling on Target (sends 0 stock, keeps the listing) or sell again. */
  app.post('/api/bulk/disable', async (req) => {
    const b = req.body as any;
    const ids = await idsFrom(b);
    const off = b.disabled !== false;
    await setOverride(ids, (ov) => { if (off) ov._disabled = true; else delete ov._disabled; return ov; });
    for (const id of ids) await enqueue('inventory', id, { force: true });
    return { updated: ids.length, disabled: off };
  });

  /**
   * Price rule: web = Shopify price (+ compare-at as list price when on sale) · percent = Shopify price ± % ·
   * fixed = this exact price. "Set price" (list/offer/MAP by hand) still wins over a rule.
   */
  app.post('/api/bulk/price-rule', async (req) => {
    const b = req.body as any;
    const ids = await idsFrom(b);
    const mode = String(b.mode ?? 'web');
    if (!['web', 'percent', 'fixed'].includes(mode)) throw bad('mode must be web, percent or fixed');
    const value = Number(b.value);
    if (mode === 'percent' && !(Number.isFinite(value) && value > -90 && value < 500)) throw bad('Percent must be between -90 and 500');
    if (mode === 'fixed' && !(Number.isFinite(value) && value > 0)) throw bad('Fixed price must be more than 0');
    await setOverride(ids, (ov) => {
      if (mode === 'web') delete ov._price_rule; else ov._price_rule = { mode, value };
      if (b.clearManual) { delete ov.list_price; delete ov.offer_price; delete ov.map_price; }
      return ov;
    });
    const sync = await getSync();
    if (sync.priceEnabled) for (const id of ids) await enqueue('price', id, { force: true });
    return { updated: ids.length, rule: mode === 'web' ? null : { mode, value }, sent: sync.priceEnabled };
  });

  /** Send switch: true = send to Target, false = never send, null = automatic (off when unlisted on Target). */
  app.post('/api/bulk/send-flag', async (req) => {
    const b = req.body as any;
    const ids = await idsFrom(b);
    const val = b.send === true || b.send === false ? b.send : null;
    await setOverride(ids, (ov) => { if (val === null) delete ov._send; else ov._send = val; return ov; });
    return { updated: ids.length, send: val };
  });

  /** Unlist on Target (approved items only). */
  app.post('/api/bulk/unlist', async (req) => {
    const ids = await idsFrom(req.body);
    const results: any[] = [];
    for (const id of ids) {
      const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, id) });
      try { await unlistVariant(id); results.push({ sku: v?.sku, ok: true }); }
      catch (e: any) { results.push({ sku: v?.sku, ok: false, error: e?.message ?? String(e) }); }
    }
    return { unlisted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  });
}

/**
 * Learn how sizes look on your existing Target items, so NEW products are sent the same way:
 *  - title size part "4 - 4.5 US / 35 EU" → size chart 35=4 - 4.5
 *  - child_variations.size value per Shopify size value
 */
export async function learnSizes() {
  const { getActiveEnv } = await import('../lib/settings.js');
  const { detectOptions } = await import('../services/builder.js');
  const env = await getActiveEnv();
  const items = await db.select().from(schema.targetItems).where(eq(schema.targetItems.env, env));
  const chartVotes = new Map<string, Map<string, number>>();
  const valueVotes = new Map<string, Map<string, number>>();
  const vote = (m: Map<string, Map<string, number>>, k: string, v: string) => { const x = m.get(k) ?? new Map(); x.set(v, (x.get(v) ?? 0) + 1); m.set(k, x); };
  const prodCache = new Map<string, any>();
  for (const t of items) {
    if (t.relationshipType === 'VAP') continue;
    const m = String(t.title ?? '').match(/(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)\s*US\s*\/\s*(\d+(?:\.\d+)?)\s*EU/i);
    if (m) vote(chartVotes, m[2], m[1].replace(/\s*-\s*/, ' - '));
    if (!t.matchedVariantId) continue;
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, t.matchedVariantId) });
    if (!v) continue;
    let p = prodCache.get(v.productId);
    if (!p) { p = await db.query.products.findFirst({ where: eq(schema.products.id, v.productId) }); prodCache.set(v.productId, p); }
    const so = p ? detectOptions(p).sizeOption : null;
    const shopSize = so ? String((v.options as any)?.[so] ?? '') : '';
    const tSize = ((t.fields ?? []) as any[]).find((f) => f.name === 'child_variations.size')?.value;
    if (shopSize && tSize) vote(valueVotes, shopSize, String(tSize));
  }
  const best = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const chart = [...chartVotes.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([eu, m]) => `${eu}=${best(m)}`).join(', ');
  const sizeValues = Object.fromEntries([...valueVotes.entries()].map(([k, m]) => [k, best(m)]));
  const conflicts = [...chartVotes.entries()].filter(([, m]) => m.size > 1).map(([eu, m]) => ({ eu, seen: Object.fromEntries(m) }));
  return { chart, sizeValues, conflicts, itemsRead: items.length };
}

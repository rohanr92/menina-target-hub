import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { env } from '../lib/env.js';
import {
  getActiveEnv, getSetting, getShopify, getSync, getTargetCreds, HubSettings, mask, setSetting,
  ShopifySettings, SyncSettings, TargetCredentials, TargetEnvName,
} from '../lib/settings.js';
import { DEFAULT_SHOPIFY_API_VERSION, normalizeShopDomain, SHOP_QUERY, shopifyGraphql } from '../shopify/client.js';
import { OAUTH_DEFAULTS, targetRequest, hostFor, taxonomyWayInUse } from '../target/client.js';

const ENVS: TargetEnvName[] = ['stage', 'production'];
const SECRET_KEEP = '__keep__'; // UI sends this to leave a secret unchanged

function maskedTarget(c: TargetCredentials, envName: TargetEnvName) {
  return {
    apiKey: mask(c.apiKey), sellerId: c.sellerId ?? '', sellerToken: mask(c.sellerToken), tgtrt: mask(c.tgtrt),
    hasApiKey: !!c.apiKey, hasSellerToken: !!c.sellerToken, hasTgtrt: !!c.tgtrt,
    authMode: c.authMode ?? 'seller_token', hostOverride: c.hostOverride ?? '', host: hostFor(envName, c), returnPolicy: c.returnPolicy ?? '',
    oauth: {
      clientId: c.oauth?.clientId ?? '', hasClientSecret: !!c.oauth?.clientSecret,
      redirectUri: c.oauth?.redirectUri ?? '', authorizeUrl: c.oauth?.authorizeUrl ?? OAUTH_DEFAULTS[envName].authorizeUrl,
      tokenUrl: c.oauth?.tokenUrl ?? OAUTH_DEFAULTS[envName].tokenUrl, connected: !!c.oauth?.refreshToken,
      expiresAt: c.oauth?.expiresAt ?? null,
    },
  };
}

function merge(old: string | undefined, incoming: any): string | undefined {
  if (incoming === undefined || incoming === SECRET_KEEP) return old;
  const v = String(incoming).trim();
  return v === '' ? undefined : v;
}

export default async function (app: FastifyInstance) {
  app.get('/api/settings', async (req) => {
    const shop = await getShopify();
    const hub = await getSetting<HubSettings>('hub', {});
    const callback = `${env.publicUrl || `${req.protocol}://${req.headers.host}`}/api/target/oauth/callback`;
    return {
      activeEnv: await getActiveEnv(),
      target: Object.fromEntries(await Promise.all(ENVS.map(async (e) => [e, maskedTarget(await getTargetCreds(e), e)]))),
      oauthCallbackUrl: callback,
      shopify: {
        shopDomain: shop.shopDomain ?? '', accessToken: mask(shop.accessToken), hasAccessToken: !!shop.accessToken,
        apiVersion: shop.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION, hasWebhookSecret: !!shop.webhookSecret,
        locationMap: shop.locationMap ?? {}, importQuery: shop.importQuery ?? 'status:active',
        webhookUrl: `${env.publicUrl || `${/localhost|127\.0\.0\.1/.test(String(req.headers.host)) ? req.protocol : 'https'}://${req.headers.host}`}/api/webhooks/shopify`,
      },
      hub: { url: hub.url ?? '', hasToken: !!hub.token },
      sync: await getSync(),
    };
  });

  app.put('/api/settings/active-env', async (req) => {
    const { env: e } = req.body as { env: TargetEnvName };
    if (!ENVS.includes(e)) throw Object.assign(new Error('env must be stage or production'), { statusCode: 400 });
    await setSetting('target.activeEnv', e);
    return { activeEnv: e };
  });

  app.put('/api/settings/target/:env', async (req) => {
    const e = (req.params as any).env as TargetEnvName;
    if (!ENVS.includes(e)) throw Object.assign(new Error('Unknown environment'), { statusCode: 400 });
    const b = req.body as any;
    const old = await getTargetCreds(e);
    const next: TargetCredentials = {
      ...old,
      apiKey: merge(old.apiKey, b.apiKey),
      sellerId: b.sellerId !== undefined ? String(b.sellerId).trim() || undefined : old.sellerId,
      sellerToken: merge(old.sellerToken, b.sellerToken),
      tgtrt: merge(old.tgtrt, b.tgtrt),
      authMode: b.authMode ?? old.authMode ?? 'seller_token',
      hostOverride: b.hostOverride !== undefined ? String(b.hostOverride).trim() || undefined : old.hostOverride,
      returnPolicy: b.returnPolicy !== undefined ? String(b.returnPolicy).trim().toUpperCase() || undefined : old.returnPolicy,
      oauth: {
        ...(old.oauth ?? {}),
        clientId: b.oauth?.clientId !== undefined ? String(b.oauth.clientId).trim() || undefined : old.oauth?.clientId,
        clientSecret: merge(old.oauth?.clientSecret, b.oauth?.clientSecret),
        redirectUri: b.oauth?.redirectUri !== undefined ? String(b.oauth.redirectUri).trim() || undefined : old.oauth?.redirectUri,
        authorizeUrl: b.oauth?.authorizeUrl !== undefined ? String(b.oauth.authorizeUrl).trim() || undefined : old.oauth?.authorizeUrl,
        tokenUrl: b.oauth?.tokenUrl !== undefined ? String(b.oauth.tokenUrl).trim() || undefined : old.oauth?.tokenUrl,
      },
    };
    await setSetting(`target.${e}`, next);
    return maskedTarget(next, e);
  });

  /** Quick credential check: distribution centers + shipping methods + taxonomy. */
  app.post('/api/settings/target/test', async (req) => {
    const e = ((req.body as any)?.env ?? (await getActiveEnv())) as TargetEnvName;
    const creds = await getTargetCreds(e);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const run = async (name: string, fn: () => Promise<string>) => {
      try { checks.push({ name, ok: true, detail: await fn() }); } catch (err: any) { checks.push({ name, ok: false, detail: err.message }); }
    };
    await run('Seller API (distribution centers)', async () => {
      const r = await targetRequest('sellers', 'GET', `/sellers/${encodeURIComponent(creds.sellerId ?? '')}/distribution_centers`, { env: e, source: 'connection-test', retries: 0 });
      return `${Array.isArray(r.data) ? r.data.length : 0} distribution center(s)`;
    });
    await run('Orders API (shipping methods)', async () => {
      const r = await targetRequest('orders', 'GET', '/shipping_methods', { env: e, query: { per_page: 5 }, source: 'connection-test', retries: 0 });
      return `${Array.isArray(r.data) ? r.data.length : 0}+ shipping method(s)`;
    });
    await run('Reports API', async () => {
      const r = await targetRequest('sellers', 'GET', `/sellers/${encodeURIComponent(creds.sellerId ?? '')}/report_requests`, { env: e, query: { per_page: 1 }, source: 'connection-test', retries: 0 });
      return `HTTP ${r.status}`;
    });
    await run('Taxonomy API (item type fields)', async () => {
      const r = await targetRequest('taxonomy', 'GET', '/attribute_values', { env: e, query: { taxonomy_id: 'root', attribute_id: 'compliance.import_designation', target: 'EXTERNAL', per_page: 5 }, source: 'connection-test', retries: 0 })
        .catch(async (err: any) => {
          // that probe can fail for reasons other than auth; fall back to a plain item type listing
          if (err?.status && ![401, 403].includes(err.status)) return targetRequest('taxonomy', 'GET', '/taxonomies', { env: e, query: { type: 'ITEM_TYPE', target: 'EXTERNAL', per_page: 1 }, source: 'connection-test', retries: 0 });
          throw err;
        });
      const w = taxonomyWayInUse(e);
      return `HTTP ${r.status}${w ? ` via ${w.host}${w.keyOnly ? ' (API key only)' : ''}` : ''}`;
    });
    return { env: e, checks };
  });

  // ---- OAuth 2.0 (authorization code flow; Target supports only this flow) ----
  app.get('/api/target/oauth/start', async (req, reply) => {
    const e = ((req.query as any).env ?? (await getActiveEnv())) as TargetEnvName;
    const creds = await getTargetCreds(e);
    const o = creds.oauth ?? {};
    if (!o.clientId || !o.clientSecret) return reply.code(400).send({ error: 'Save the OAuth Client ID and Client Secret first' });
    const redirectUri = o.redirectUri || `${env.publicUrl || `${req.protocol}://${req.headers.host}`}/api/target/oauth/callback`;
    const state = `${e}.${randomBytes(12).toString('hex')}`;
    const nonce = randomBytes(8).toString('hex');
    await setSetting(`target.${e}`, { ...creds, oauth: { ...o, pendingRedirect: redirectUri, pendingState: state, pendingNonce: nonce } as any });
    const url = new URL(o.authorizeUrl || OAUTH_DEFAULTS[e].authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', o.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'openid profile email');
    return reply.redirect(url.toString());
  });

  app.get('/api/target/oauth/callback', async (req, reply) => {
    const q = req.query as any;
    const e = (String(q.state ?? '').split('.')[0] || (await getActiveEnv())) as TargetEnvName;
    const creds = await getTargetCreds(ENVS.includes(e) ? e : 'stage');
    const o = creds.oauth ?? {};
    if (q.error) return reply.redirect(`/settings?oauth=error&message=${encodeURIComponent(q.error_description ?? q.error)}`);
    if (o.pendingState && q.state && q.state !== o.pendingState) return reply.redirect('/settings?oauth=error&message=state%20mismatch');
    const tokenUrl = o.tokenUrl || OAUTH_DEFAULTS[e].tokenUrl;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: (o as any).pendingRedirect ?? o.redirectUri ?? '', code: String(q.code ?? ''), nonce: o.pendingNonce ?? '' }),
    });
    const text = await res.text();
    if (!res.ok) return reply.redirect(`/settings?oauth=error&message=${encodeURIComponent(`Token exchange failed (${res.status}): ${text.slice(0, 200)}`)}`);
    const j = JSON.parse(text);
    await setSetting(`target.${e}`, {
      ...creds,
      authMode: creds.authMode === 'seller_token' ? 'both' : creds.authMode ?? 'oauth',
      oauth: { ...o, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, pendingState: undefined, pendingNonce: undefined, pendingRedirect: undefined } as any,
    });
    return reply.redirect('/settings?oauth=connected');
  });

  app.post('/api/target/oauth/disconnect', async (req) => {
    const e = ((req.body as any)?.env ?? (await getActiveEnv())) as TargetEnvName;
    const creds = await getTargetCreds(e);
    await setSetting(`target.${e}`, { ...creds, oauth: { ...creds.oauth, accessToken: undefined, refreshToken: undefined, expiresAt: undefined } });
    return { ok: true };
  });

  // ---- Shopify ----
  app.put('/api/settings/shopify', async (req) => {
    const b = req.body as any;
    const old = await getShopify();
    const next: ShopifySettings = {
      ...old,
      shopDomain: b.shopDomain !== undefined ? (b.shopDomain ? normalizeShopDomain(b.shopDomain) : undefined) : old.shopDomain,
      accessToken: merge(old.accessToken, b.accessToken),
      apiVersion: b.apiVersion !== undefined ? String(b.apiVersion).trim() || undefined : old.apiVersion,
      webhookSecret: merge(old.webhookSecret, b.webhookSecret),
      locationMap: b.locationMap ?? old.locationMap,
      importQuery: b.importQuery ?? old.importQuery,
    };
    await setSetting('shopify', next);
    return { ok: true };
  });

  app.post('/api/settings/shopify/test', async () => {
    const d: any = await shopifyGraphql(SHOP_QUERY, {}, 'connection-test');
    return { shop: d.shop, locations: d.locations.nodes };
  });

  app.put('/api/settings/hub', async (req) => {
    const b = req.body as any;
    const old = await getSetting<HubSettings>('hub', {});
    await setSetting('hub', { url: b.url !== undefined ? String(b.url).trim() || undefined : old.url, token: merge(old.token, b.token) });
    return { ok: true };
  });

  app.put('/api/settings/sync', async (req) => {
    const cur = await getSync();
    const b = req.body as Partial<SyncSettings>;
    const next: SyncSettings = {
      ...cur, ...b,
      price: { ...cur.price, ...(b.price ?? {}) },
      stage: { ...cur.stage, ...(b.stage ?? {}) },
      defaultLogistics: { ...cur.defaultLogistics, ...(b.defaultLogistics ?? {}) },
      carrierMap: b.carrierMap ?? cur.carrierMap,
      titles: { ...cur.titles, ...(b.titles ?? {}) },
    };
    next.requestsPerSecond = Math.max(0.2, Math.min(20, Number(next.requestsPerSecond) || 2));
    next.inventoryIntervalMin = Math.max(5, Number(next.inventoryIntervalMin) || 30);
    next.ordersIntervalMin = Math.max(5, Number(next.ordersIntervalMin) || 15);
    next.statusIntervalMin = Math.max(5, Number(next.statusIntervalMin) || 15);
    next.safetyStock = Math.max(0, Number(next.safetyStock) || 0);
    // first time orders are switched on in production: orders before this moment belong to the old integration
    if (next.ordersEnabled && !cur.ordersEnabled && !next.ordersCutoverAt && (await getActiveEnv()) === 'production') next.ordersCutoverAt = new Date().toISOString();
    await setSetting('sync', next);
    return next;
  });
}

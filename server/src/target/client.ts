// Target Plus HTTP client: auth headers, rate limiting, retries, logging.
import { logApi } from '../lib/apilog.js';
import { getActiveEnv, getSync, getTargetCreds, setSetting, TargetCredentials, TargetEnvName } from '../lib/settings.js';

export type Api = 'sellers' | 'orders' | 'taxonomy';

const DEFAULT_HOST: Record<TargetEnvName, string> = {
  stage: 'https://stage-api.target.com',
  production: 'https://api.target.com',
};
const BASE_PATH: Record<Api, string> = {
  sellers: '/sellers/v1',
  orders: '/seller_orders/v1',
  taxonomy: '/item_taxonomies/v2',
};

export const OAUTH_DEFAULTS: Record<TargetEnvName, { authorizeUrl: string; tokenUrl: string }> = {
  stage: {
    authorizeUrl: 'https://oauth.plus.iam.perf.partnersonline.com/auth/oauth/v2/tgt/authorize/nla/1',
    tokenUrl: 'https://oauth.plus.iam.perf.partnersonline.com/auth/oauth/v2/token',
  },
  production: {
    authorizeUrl: 'https://oauth.plus.iam.partnersonline.com/auth/oauth/v2/tgt/authorize/nla/1',
    tokenUrl: 'https://oauth.plus.iam.partnersonline.com/auth/oauth/v2/token',
  },
};

export class TargetError extends Error {
  constructor(message: string, public status: number, public body: any, public url: string) {
    super(message);
  }
}

// ---- simple global rate limiter (requests per second) ----
let nextSlot = 0;
async function throttle() {
  const { requestsPerSecond } = await getSync();
  const gap = 1000 / Math.max(0.2, Math.min(20, requestsPerSecond || 2));
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export function hostFor(envName: TargetEnvName, creds: TargetCredentials) {
  return (creds.hostOverride?.replace(/\/$/, '') || DEFAULT_HOST[envName]);
}

export async function baseUrl(api: Api, envName?: TargetEnvName) {
  const e = envName ?? (await getActiveEnv());
  const creds = await getTargetCreds(e);
  return hostFor(e, creds) + BASE_PATH[api];
}

const refreshing = new Map<TargetEnvName, Promise<TargetCredentials>>();

/** One refresh at a time per environment (worker, scheduler and UI share it). */
async function refreshIfNeeded(envName: TargetEnvName, creds: TargetCredentials): Promise<TargetCredentials> {
  const o = creds.oauth;
  if (!o?.refreshToken || !o.clientId || !o.clientSecret) return creds;
  if (o.accessToken && o.expiresAt && o.expiresAt - Date.now() > 120_000) return creds;
  if (!refreshing.has(envName)) {
    refreshing.set(envName, doRefresh(envName, creds).finally(() => refreshing.delete(envName)));
  }
  return refreshing.get(envName)!;
}

async function doRefresh(envName: TargetEnvName, creds: TargetCredentials): Promise<TargetCredentials> {
  const o = creds.oauth!;
  const tokenUrl = o.tokenUrl || OAUTH_DEFAULTS[envName].tokenUrl;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: o.refreshToken! }),
  });
  const text = await res.text();
  await logApi({ service: 'target', env: envName, method: 'POST', url: tokenUrl, status: res.status, responseBody: res.ok ? '[token response hidden]' : text, source: 'oauth-refresh' });
  if (!res.ok) throw new TargetError(`OAuth refresh failed (${res.status}). Reconnect Target in Settings.`, res.status, text, tokenUrl);
  const j = JSON.parse(text);
  const next: TargetCredentials = {
    ...creds,
    oauth: {
      ...o,
      accessToken: j.access_token,
      refreshToken: j.refresh_token || o.refreshToken,
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    },
  };
  await setSetting(`target.${envName}`, next);
  return next;
}

export async function authHeaders(envName: TargetEnvName, opts: { forDownload?: boolean; keyOnly?: boolean } = {}) {
  let creds = await getTargetCreds(envName);
  if (!creds.apiKey || !creds.sellerId) throw new TargetError(`Target ${envName} credentials are not set. Add them in Settings.`, 0, null, '');
  const mode = creds.authMode ?? 'seller_token';
  const h: Record<string, string> = { 'x-api-key': creds.apiKey, 'x-seller-id': creds.sellerId };
  if (opts.keyOnly) return { headers: h, creds };
  if ((mode === 'seller_token' || mode === 'both') && creds.sellerToken) h['x-seller-token'] = creds.sellerToken;
  if (mode === 'oauth' || mode === 'both') {
    creds = await refreshIfNeeded(envName, creds);
    if (creds.oauth?.accessToken) h['authorization'] = `Bearer ${creds.oauth.accessToken}`;
  }
  if (opts.forDownload && envName === 'stage' && creds.tgtrt) h['tgtrt'] = creds.tgtrt;
  return { headers: h, creds };
}

export interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  source?: string;
  env?: TargetEnvName;
  hideResponse?: boolean; // e.g. addresses (PII)
  retries?: number;
  /** POST that creates something (item, fulfillment): only retry when Target clearly rejected it (429). */
  nonIdempotent?: boolean;
  /** send only x-api-key + x-seller-id (no seller token / bearer) */
  keyOnly?: boolean;
}

export interface TargetResponse<T = any> {
  status: number;
  data: T;
  headers: Headers;
  total?: number;
}

/**
 * Taxonomy on stage: the guide and the kickoff deck point the Taxonomy API at api.target.com, and stage-api answers 401
 * for it. So for taxonomy we try (host, auth) combinations in order and remember the first that works.
 */
type TaxoWay = { host: string; keyOnly: boolean };
const taxoWayCache = new Map<TargetEnvName, TaxoWay>();
export function taxonomyWays(envName: TargetEnvName, creds: TargetCredentials): TaxoWay[] {
  if (creds.hostOverride) return [{ host: hostFor(envName, creds), keyOnly: false }];
  const own = DEFAULT_HOST[envName], prod = DEFAULT_HOST.production;
  const ways: TaxoWay[] = [{ host: own, keyOnly: false }, { host: prod, keyOnly: false }, { host: prod, keyOnly: true }, { host: own, keyOnly: true }];
  return ways.filter((w, i) => ways.findIndex((x) => x.host === w.host && x.keyOnly === w.keyOnly) === i);
}

export async function targetRequest<T = any>(api: Api, method: string, path: string, opts: RequestOpts = {}): Promise<TargetResponse<T>> {
  const envName = opts.env ?? (await getActiveEnv());
  const build = (host: string) => {
    const url = new URL(host + BASE_PATH[api] + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
  };
  if (api !== 'taxonomy') return rawRequest<T>(envName, method, build(hostFor(envName, await getTargetCreds(envName))), opts);
  const creds = await getTargetCreds(envName);
  const cached = taxoWayCache.get(envName);
  const ways = cached ? [cached, ...taxonomyWays(envName, creds).filter((w) => w.host !== cached.host || w.keyOnly !== cached.keyOnly)] : taxonomyWays(envName, creds);
  let last: any;
  for (const w of ways) {
    try {
      const r = await rawRequest<T>(envName, method, build(w.host), { ...opts, keyOnly: w.keyOnly, retries: Math.min(opts.retries ?? 2, 2) });
      taxoWayCache.set(envName, w);
      return r;
    } catch (e: any) {
      last = e;
      if (!(e instanceof TargetError) || ![401, 403, 404].includes(e.status)) throw e;
    }
  }
  throw last;
}
export const taxonomyWayInUse = (envName: TargetEnvName) => taxoWayCache.get(envName) ?? null;

/** Request against an absolute URL (e.g. a report download_url). */
export async function rawRequest<T = any>(envName: TargetEnvName, method: string, url: string, opts: RequestOpts & { forDownload?: boolean; accept?: string } = {}): Promise<TargetResponse<T>> {
  const maxRetries = opts.retries ?? 4;
  const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  let attempt = 0;
  for (;;) {
    attempt++;
    const { headers } = await authHeaders(envName, { forDownload: opts.forDownload, keyOnly: opts.keyOnly });
    if (bodyText) headers['content-type'] = 'application/json';
    headers['accept'] = opts.accept ?? 'application/json';
    await throttle();
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: bodyText, signal: AbortSignal.timeout(60_000) });
    } catch (e: any) {
      await logApi({ service: 'target', env: envName, method, url, durationMs: Date.now() - started, requestBody: bodyText, error: String(e?.message ?? e), source: opts.source });
      if (attempt <= maxRetries && !opts.nonIdempotent) { await sleep(backoff(attempt)); continue; }
      // ambiguous: Target may or may not have processed it. Callers reconcile before retrying.
      throw Object.assign(new TargetError(`Network error calling Target: ${e?.message ?? e}`, 0, null, url), { ambiguous: true });
    }
    // downloads (reports) can be Excel files: read raw bytes so they are not corrupted by text decoding
    let binary: Buffer | null = null;
    let text: string;
    if (opts.forDownload) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ctype = res.headers.get('content-type') ?? '';
      const isBin = /spreadsheet|excel|octet-stream|zip/i.test(ctype) || (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b);
      if (isBin) { binary = buf; text = ''; } else text = buf.toString('utf8');
    } else text = await res.text();
    const durationMs = Date.now() - started;
    await logApi({
      service: 'target', env: envName, method, url, status: res.status, durationMs,
      requestBody: bodyText, responseBody: binary ? `[file, ${binary.length} bytes]` : opts.hideResponse && res.ok ? '[hidden: contains customer data]' : text,
      source: opts.source,
    });
    if ((res.status === 429 || (res.status >= 500 && !opts.nonIdempotent)) && attempt <= maxRetries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
      continue;
    }
    let data: any = binary ?? text;
    const ct = res.headers.get('content-type') ?? '';
    if (!binary && text && (ct.includes('json') || /^[\[{]/.test(text.trim()))) {
      try { data = JSON.parse(text); } catch { /* keep text */ }
    }
    if (!res.ok) {
      throw Object.assign(new TargetError(errorMessage(res.status, data), res.status, data, url), { ambiguous: res.status >= 500 });
    }
    const totalHeader = res.headers.get('x-total-count');
    return { status: res.status, data, headers: res.headers, total: totalHeader ? Number(totalHeader) : undefined };
  }
}

function errorMessage(status: number, data: any): string {
  if (data && typeof data === 'object') {
    const msg = data.message || data.error_description || data.error || data.errors?.map?.((e: any) => e.reason || e.message || JSON.stringify(e)).join('; ');
    if (msg) return `Target ${status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
    return `Target ${status}: ${JSON.stringify(data).slice(0, 500)}`;
  }
  return `Target ${status}: ${String(data || '').slice(0, 500)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)) + Math.random() * 300;

/** First page body of the last getAllPages call (shown in errors when Target returns an empty or unexpected list). */
export let lastFirstPage = '';

/** Fetch every page of a page/per_page paginated list. */
export async function getAllPages<T = any>(api: Api, path: string, query: Record<string, any> = {}, opts: RequestOpts & { perPage?: number; maxPages?: number } = {}): Promise<T[]> {
  const perPage = opts.perPage ?? 100;
  const out: T[] = [];
  let firstKey = '';
  for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
    const r = await targetRequest<T[]>(api, 'GET', path, { ...opts, query: { ...query, page, per_page: perPage } });
    const d: any = r.data;
    const items: any[] = Array.isArray(d) ? d : (['data', 'items', 'results', 'assignments', 'attribute_values', 'values', 'taxonomies'].map((k) => d?.[k]).find(Array.isArray) ?? []);
    if (page === 1) lastFirstPage = typeof d === 'string' ? d.slice(0, 400) : JSON.stringify(d ?? null).slice(0, 400);
    if (!items.length) break;
    // guard against an API that ignores "page" and keeps returning the same page
    const key = JSON.stringify(items[0]).slice(0, 200);
    if (page > 1 && key === firstKey) break;
    if (page === 1) firstKey = key;
    out.push(...items);
    if (r.total !== undefined) { if (out.length >= r.total) break; }
    else if (items.length < Math.min(perPage, 10)) break; // short page, no total header: last page
  }
  return out;
}

export { sleep };

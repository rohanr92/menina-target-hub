import { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { dt } from '../lib/format';
import { Btn, Card, Copy, ErrorBox, Field, Loading, PageHead, Tabs, useAction, useLoad, useToast } from '../components/ui';

const KEEP = '__keep__';

function Secret({ label, has, value, onChange, hint }: { label: string; has: boolean; value: string; onChange: (v: string) => void; hint?: string }) {
  const [editing, setEditing] = useState(!has);
  if (!editing) return (
    <Field label={label} hint={hint}><div className="row" style={{ flexWrap: 'nowrap' }}><input style={{ flex: 1 }} value="•••••••••• saved (encrypted)" disabled /><button type="button" className="btn sm" onClick={() => { setEditing(true); onChange(''); }}>Change</button></div></Field>
  );
  return <Field label={label} hint={hint}><input type="password" autoComplete="off" value={value === KEEP ? '' : value} onChange={(e) => onChange(e.target.value)} placeholder="Paste value" /></Field>;
}

function TargetEnvForm({ env, s, oauthCallbackUrl, reload }: { env: 'stage' | 'production'; s: any; oauthCallbackUrl: string; reload: () => void }) {
  const t = s.target[env];
  const [f, setF] = useState<any>({ apiKey: KEEP, sellerId: t.sellerId, sellerToken: KEEP, tgtrt: KEEP, authMode: t.authMode, hostOverride: t.hostOverride, returnPolicy: t.returnPolicy, oauth: { clientId: t.oauth.clientId, clientSecret: KEEP, redirectUri: t.oauth.redirectUri, authorizeUrl: t.oauth.authorizeUrl, tokenUrl: t.oauth.tokenUrl } });
  const [checks, setChecks] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const setO = (k: string, v: any) => setF((x: any) => ({ ...x, oauth: { ...x.oauth, [k]: v } }));
  const save = () => run('save', () => put(`/api/settings/target/${env}`, f), 'Saved (encrypted)').then(reload);
  return (
    <div className="grid2">
      <Card title={`${env === 'stage' ? 'Stage' : 'Production'} credentials`}>
        <div className="stack">
          <Secret label="API key (x-api-key)" has={t.hasApiKey} value={f.apiKey} onChange={(v) => set('apiKey', v)} />
          <Field label="Seller ID (x-seller-id)" hint={env === 'stage' ? 'The “SMS ID from Marketplace Stage” in your Stage API Credentials doc' : 'Find it in the Seller Portal'}>
            <input value={f.sellerId} onChange={(e) => set('sellerId', e.target.value)} />
          </Field>
          <Field label="Authentication">
            <select value={f.authMode} onChange={(e) => set('authMode', e.target.value)}>
              <option value="seller_token">Seller token (x-seller-token)</option>
              <option value="oauth">OAuth 2.0 bearer token</option>
              <option value="both">Both (send seller token and bearer token)</option>
            </select>
          </Field>
          {f.authMode !== 'oauth' && <Secret label="Seller token (x-seller-token)" has={t.hasSellerToken} value={f.sellerToken} onChange={(v) => set('sellerToken', v)} />}
          {env === 'stage' && <Secret label="tgtrt token (stage report downloads)" has={t.hasTgtrt} value={f.tgtrt} onChange={(v) => set('tgtrt', v)} hint="Needed to download reports (e.g. ALLOWED_ITEM_TYPES) on Stage" />}
          <Field label="Return policy ID" hint="3-letter code from the portal (Basic Info › Return Policies), e.g. AAC"><input value={f.returnPolicy} onChange={(e) => set('returnPolicy', e.target.value)} /></Field>
          <Field label="API host override (optional)" hint={`Default: ${env === 'stage' ? 'https://stage-api.target.com' : 'https://api.target.com'}`}><input value={f.hostOverride} onChange={(e) => set('hostOverride', e.target.value)} placeholder="leave empty" /></Field>
          <div className="row">
            <Btn kind="primary" busy={busy === 'save'} onClick={save}>Save</Btn>
            <Btn busy={busy === 'test'} onClick={() => run('test', async () => { const r = await post('/api/settings/target/test', { env }); setChecks(r.checks); return r; })}>Test connection</Btn>
          </div>
          {checks && <div className="stack">{checks.map((c) => <div key={c.name} className={`small ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? '✓' : '✕'} {c.name}: {c.detail}</div>)}</div>}
        </div>
      </Card>
      <Card title="OAuth 2.0 (authorization code flow)">
        <div className="stack small">
          <p className="muted" style={{ margin: 0 }}>In the marketplace portal ({env === 'stage' ? 'plus.perf.target.com' : 'plus-portal.target.com'}) go to Partner Settings › API Integration, create a Security Profile and add this as an allowed return URL, then generate a Client ID + Secret:</p>
          <div className="row"><code style={{ wordBreak: 'break-all' }}>{f.oauth.redirectUri || oauthCallbackUrl}</code><Copy text={f.oauth.redirectUri || oauthCallbackUrl} /></div>
          <Field label="Client ID"><input value={f.oauth.clientId} onChange={(e) => setO('clientId', e.target.value)} /></Field>
          <Secret label="Client secret" has={t.oauth.hasClientSecret} value={f.oauth.clientSecret} onChange={(v) => setO('clientSecret', v)} />
          <Field label="Redirect URI (optional override)"><input value={f.oauth.redirectUri} onChange={(e) => setO('redirectUri', e.target.value)} placeholder={oauthCallbackUrl} /></Field>
          <Field label="Authorization URL"><input value={f.oauth.authorizeUrl} onChange={(e) => setO('authorizeUrl', e.target.value)} /></Field>
          <Field label="Token URL"><input value={f.oauth.tokenUrl} onChange={(e) => setO('tokenUrl', e.target.value)} /></Field>
          <div>Status: {t.oauth.connected ? <span className="ok">connected · token expires {dt(t.oauth.expiresAt)} (refreshes automatically)</span> : <span className="muted">not connected</span>}</div>
          <div className="row">
            <Btn busy={busy === 'save'} onClick={save}>Save</Btn>
            <a className="btn primary" href={`/api/target/oauth/start?env=${env}`}>Connect with Target</a>
            {t.oauth.connected && <Btn kind="ghost" onClick={() => run('dc', () => post('/api/target/oauth/disconnect', { env }), 'Disconnected').then(reload)}>Disconnect</Btn>}
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Instant stock / price sync: Shopify calls the hub the moment stock or a product changes. */
function WebhookBox() {
  const w = useLoad(() => get('/api/shopify/webhooks'));
  const { busy, run } = useAction();
  const d: any = w.data;
  return (
    <div className="small" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
      <strong>Instant sync (webhooks)</strong>{' '}
      {w.error ? <span className="bad">{w.error}</span> : !d ? <span className="muted">checking…</span>
        : !d.missing?.length ? <span className="ok">on: stock and price changes in Shopify are sent to Target within seconds</span>
        : <span className="warn">off ({d.missing.join(', ')} not registered){!d.hasSecret ? ' · paste the app client secret above and Save first' : ''}</span>}
      <div style={{ marginTop: 6 }}><Btn size="sm" busy={busy === 'wh'} onClick={() => run('wh', () => post('/api/shopify/webhooks/register'), (r: any) => r.results.map((x: any) => `${x.topic}: ${x.status}`).join(' · ')).then(w.reload)}>Turn on instant sync</Btn></div>
    </div>
  );
}

function ShopifyForm({ s, reload }: { s: any; reload: () => void }) {
  const sh = s.shopify;
  const [f, setF] = useState<any>({ shopDomain: sh.shopDomain, accessToken: KEEP, apiVersion: sh.apiVersion, webhookSecret: KEEP, importQuery: sh.importQuery });
  const [locMap, setLocMap] = useState<Record<string, string>>(sh.locationMap ?? {});
  const [locations, setLocations] = useState<any[] | null>(null);
  const dcs = useLoad(() => get('/api/taxonomy/setup'));
  const { busy, run } = useAction();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  return (
    <div className="grid2">
      <Card title="Shopify store">
        <div className="stack">
          <Field label="Store domain" hint="your-store.myshopify.com"><input value={f.shopDomain} onChange={(e) => set('shopDomain', e.target.value)} placeholder="menina-step-handcrafted-in-spain.myshopify.com" /></Field>
          <Secret label="Admin API access token" has={sh.hasAccessToken} value={f.accessToken} onChange={(v) => set('accessToken', v)} hint="Scopes: read_products, read_inventory, read_locations, write_orders, read_orders, read_fulfillments" />
          <Field label="Admin API version"><input value={f.apiVersion} onChange={(e) => set('apiVersion', e.target.value)} /></Field>
          <Field label="Import filter (Shopify search syntax)" hint={'e.g. status:active  ·  vendor:"Menina Step"  ·  tag:target'}><input value={f.importQuery} onChange={(e) => set('importQuery', e.target.value)} /></Field>
          <Secret label="Webhook signing secret (optional)" has={sh.hasWebhookSecret} value={f.webhookSecret} onChange={(v) => set('webhookSecret', v)} hint="App client secret. Enables near-real-time stock updates via webhooks." />
          <div className="small muted">Webhook URL (topics: inventory_levels/update, products/update): <code>{sh.webhookUrl}</code> <Copy text={sh.webhookUrl} /></div>
          <WebhookBox />
          <div className="row">
            <Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => put('/api/settings/shopify', f), 'Saved').then(reload)}>Save</Btn>
            <Btn busy={busy === 'test'} onClick={() => run('test', async () => { const r = await post('/api/settings/shopify/test'); setLocations(r.locations); return r; }, (r: any) => `Connected to ${r.shop.name}`)}>Test & load locations</Btn>
          </div>
        </div>
      </Card>
      <Card title="Stock locations → Target distribution centers">
        <div className="stack small">
          <p className="muted" style={{ margin: 0 }}>Choose which Shopify locations feed each Target DC. Unmapped locations are not sent. With no mapping, the total stock goes to your first DC.</p>
          {!locations && <div className="muted">Click “Test & load locations” first.</div>}
          {locations && !dcs.data?.distributionCenters?.length && <div className="warn">No distribution centers yet. Go to Taxonomy › Pull setup data.</div>}
          {locations?.map((l) => (
            <div key={l.id} className="row between">
              <span>{l.name} {!l.isActive && <span className="muted">(inactive)</span>}</span>
              <select style={{ width: 240 }} value={locMap[l.id] ?? ''} onChange={(e) => setLocMap((m) => ({ ...m, [l.id]: e.target.value }))}>
                <option value="">— not sent —</option>
                {dcs.data?.distributionCenters?.map((d: any) => <option key={d.id} value={d.id}>{d.name} ({d.id})</option>)}
              </select>
            </div>
          ))}
          {locations && <div><Btn kind="primary" busy={busy === 'map'} onClick={() => run('map', () => put('/api/settings/shopify', { locationMap: Object.fromEntries(Object.entries(locMap).filter(([, v]) => v)) }), 'Location mapping saved').then(reload)}>Save mapping</Btn></div>}
        </div>
      </Card>
    </div>
  );
}

function HubForm({ s, reload }: { s: any; reload: () => void }) {
  const [url, setUrl] = useState(s.hub.url);
  const [token, setToken] = useState(KEEP);
  const { busy, run } = useAction();
  return (
    <Card title="Marketplace Hub import (optional)">
      <div className="stack" style={{ maxWidth: 640 }}>
        <p className="muted small" style={{ margin: 0 }}>Import products from your Marketplace Hub instead of (or in addition to) Shopify. The URL must return a JSON list of products with variants (sku, barcode, price, options, inventory). Products keep their Target mapping when re-imported.</p>
        <Field label="Export URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-marketplace-hub.up.railway.app/api/export/products" /></Field>
        <Secret label="Bearer token" has={s.hub.hasToken} value={token} onChange={setToken} />
        <div><Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => put('/api/settings/hub', { url, token }), 'Saved').then(reload)}>Save</Btn></div>
      </div>
    </Card>
  );
}

function SyncForm({ s, reload }: { s: any; reload: () => void }) {
  const [f, setF] = useState<any>(s.sync);
  const { busy, run } = useAction();
  const set = (path: string, v: any) => setF((x: any) => {
    const [a, b] = path.split('.');
    return b ? { ...x, [a]: { ...x[a], [b]: v } } : { ...x, [a]: v };
  });
  const chk = (path: string, label: string) => {
    const [a, b] = path.split('.');
    const val = b ? f[a][b] : f[a];
    return <label className="inline-check"><input type="checkbox" checked={!!val} onChange={(e) => set(path, e.target.checked)} />{label}</label>;
  };
  const yn = (k: string, label: string) => (
    <Field label={label}><select value={f.defaultLogistics[k]} onChange={(e) => set(`defaultLogistics.${k}`, e.target.value)}><option>No</option><option>Yes</option></select></Field>
  );
  return (
    <div className="stack">
      <div className="grid3">
        <Card title="Automation">
          <div className="stack">
            {chk('ordersEnabled', 'Pull Target orders automatically')}
            <Field label="Order pull interval (minutes)"><input type="number" value={f.ordersIntervalMin} onChange={(e) => set('ordersIntervalMin', Number(e.target.value))} /></Field>
            {chk('autoAcknowledge', 'Acknowledge new orders automatically')}
            {chk('pushOrdersToShopify', 'Create Target orders in Shopify (recommended: stock decrements there)')}
            {!f.pushOrdersToShopify && chk('deductShopifyStock', 'Otherwise deduct sold units from Shopify stock')}
            {chk('syncTrackingFromShopify', 'Send Shopify tracking to Target')}
            {chk('returnsToShopify', 'Target returns: refund + tag “Target return” on the Shopify order')}
            {f.returnsToShopify && chk('restockReturns', 'Put returned units back in Shopify stock')}
            <div className="small muted">Orders before {f.ordersCutoverAt ? dt(f.ordersCutoverAt) : 'the moment you turn on order pulling'} belong to the old integration: they are shown, never created in Shopify again.</div>
            <hr style={{ margin: '4px 0' }} />
            {chk('inventoryEnabled', 'Sync inventory to Target')}
            {chk('priceEnabled', 'Sync prices to Target')}
            <Field label="Stock/price reconcile interval (minutes)"><input type="number" value={f.inventoryIntervalMin} onChange={(e) => set('inventoryIntervalMin', Number(e.target.value))} /></Field>
            <Field label="Item status check interval (minutes)"><input type="number" value={f.statusIntervalMin} onChange={(e) => set('statusIntervalMin', Number(e.target.value))} /></Field>
            <Field label="Max Target API requests / second" hint="All calls go through one throttled queue"><input type="number" step="0.5" value={f.requestsPerSecond} onChange={(e) => set('requestsPerSecond', Number(e.target.value))} /></Field>
          </div>
        </Card>
        <Card title="Inventory & price rules">
          <div className="stack">
            <Field label="Buffer for all items (units held back per SKU, usually 0)" hint="Per-SKU buffer: Price & inventory › select SKUs › Buffer"><input type="number" value={f.safetyStock} onChange={(e) => set('safetyStock', Number(e.target.value))} /></Field>
            <Field label="Max quantity per item (optional)"><input type="number" value={f.maxQtyPerItem ?? ''} onChange={(e) => set('maxQtyPerItem', e.target.value === '' ? null : Number(e.target.value))} /></Field>
            {chk('reserveOpenOrders', 'Hold back stock for open Target orders not yet in Shopify')}
            <Field label="List price from"><select value={f.price.listFrom} onChange={(e) => set('price.listFrom', e.target.value)}><option value="compare_at_or_price">Compare-at price (if higher), else price</option><option value="price">Price</option></select></Field>
            <Field label="Offer (sale) price"><select value={f.price.offerFrom} onChange={(e) => set('price.offerFrom', e.target.value)}><option value="price">Shopify price when lower than list</option><option value="none">Don’t send</option></select></Field>
            <Field label="MAP price"><select value={f.price.mapFrom} onChange={(e) => set('price.mapFrom', e.target.value)}><option value="none">Don’t send</option><option value="price">Shopify price</option></select></Field>
            <Field label="Price multiplier" hint="e.g. 1.10 adds 10% to cover the commission"><input type="number" step="0.01" value={f.price.multiplier} onChange={(e) => set('price.multiplier', Number(e.target.value))} /></Field>
            {chk('price.roundTo99', 'Round to .99')}
          </div>
        </Card>
        <Card title="Listing defaults">
          <div className="stack">
            <Field label="Stage brand override" hint="Target stage only accepts “Valor Fitness”"><input value={f.stage.forceBrand} onChange={(e) => set('stage.forceBrand', e.target.value)} /></Field>
            {chk('stage.useMockBarcodes', 'Use generated test barcodes on stage')}
            {chk('stage.allowShopifyWrites', 'Allow stage test orders to write to Shopify (orders / stock)')}
            <span className="small muted">Keep this off: stage test orders would otherwise create orders or change stock in your real store.</span>
            <Field label="Parent (VAP) SKU pattern" hint="Tokens: {handle} {sku} {title}"><input value={f.parentSkuPattern} onChange={(e) => set('parentSkuPattern', e.target.value)} /></Field>
            {yn('is_add_on', 'Add-on item')}
            {yn('two_day_shipping_eligible', 'Two-day shipping eligible')}
            {yn('shipping_exclusion', 'Shipping exclusion (AK, HI, PR, APO…)')}
            <Field label="Return policy override" hint="Empty = the policy saved with your credentials"><input value={f.defaultLogistics.seller_return_policy} onChange={(e) => set('defaultLogistics.seller_return_policy', e.target.value.toUpperCase())} /></Field>
          </div>
        </Card>
      </div>
      <Card title="Product titles (sent to Target)">
        <div className="stack" style={{ maxWidth: 820 }}>
          <span className="small muted">Tokens: <code>{'{brand}'}</code> Shopify vendor · <code>{'{audience}'}</code> · <code>{'{name}'}</code> Shopify title without brand / Women's / color / size · <code>{'{color}'}</code> the Target color of the SKU · <code>{'{us}'}</code> <code>{'{eu}'}</code> sizes from the chart below · <code>{'{size}'}</code> size as in Shopify. Text in <code>[ ]</code> is left out when a token inside is empty. A title you typed yourself on a SKU always wins.</span>
          <Field label="Size / color items (VC)"><input value={f.titles.child} onChange={(e) => set('titles.child', e.target.value)} /></Field>
          <Field label="Stand-alone items (SA)"><input value={f.titles.standalone} onChange={(e) => set('titles.standalone', e.target.value)} /></Field>
          <Field label="Parent (VAP) title"><input value={f.titles.parent} onChange={(e) => set('titles.parent', e.target.value)} /></Field>
          <div className="grid2">
            <Field label="Audience word"><input value={f.titles.audience} onChange={(e) => set('titles.audience', e.target.value)} /></Field>
            <Field label="EU → US size chart" hint="EU=US, separated by commas"><input value={f.titles.sizeChart} onChange={(e) => set('titles.sizeChart', e.target.value)} /></Field>
          </div>
          <div className="row">
            <Btn size="sm" busy={busy === 'learn'} onClick={() => run('learn', async () => {
              const r = await post('/api/settings/learn-sizes', {});
              if (!r.chart) throw new Error('No sizes found in your Target catalog. Fetch it first (Target catalog › 1 · Fetch from Target).');
              const vals = Object.entries(r.sizeValues).map(([k, v]) => `${k} → ${v}`).join(', ');
              if (!confirm(`Sizes on your existing Target items:\n\nSize chart: ${r.chart}\n\nSize values: ${vals || '-'}${r.conflicts.length ? `\n\nMixed on Target (most used is taken): ${r.conflicts.map((c: any) => c.eu).join(', ')}` : ''}\n\nUse these for NEW products?`)) return undefined as any;
              await post('/api/settings/learn-sizes', { save: true });
              return r;
            }, (r: any) => (r ? 'Size chart saved from your Target items' : 'Not changed')).then(reload)}>Copy sizes from my Target items</Btn>
            <span className="small muted">New products then get the same size text as your existing ones (e.g. 4 - 4.5 US / 35 EU)</span>
          </div>
          <span className="small">Example: <strong>Menina Step Women's Jimena High Laces French Laced Taupe 9 US / 39 EU</strong></span>
        </div>
      </Card>
      <Card title="Carrier → Target shipping method (for tracking from Shopify)">
        <div className="stack" style={{ maxWidth: 560 }}>
          {Object.entries(f.carrierMap as Record<string, string>).map(([k, v]) => (
            <div key={k} className="row">
              <input style={{ width: 160 }} value={k} disabled />
              <span>→</span>
              <input style={{ width: 240 }} value={v} onChange={(e) => setF((x: any) => ({ ...x, carrierMap: { ...x.carrierMap, [k]: e.target.value } }))} />
              <button className="btn ghost sm" onClick={() => setF((x: any) => { const m = { ...x.carrierMap }; delete m[k]; return { ...x, carrierMap: m }; })}>Remove</button>
            </div>
          ))}
          <button className="btn sm" style={{ width: 'fit-content' }} onClick={() => { const k = prompt('Carrier name as it appears in Shopify tracking (e.g. "dhl")'); if (k) setF((x: any) => ({ ...x, carrierMap: { ...x.carrierMap, [k.toLowerCase()]: '' } })); }}>Add carrier</button>
          <span className="small muted">Method names must match your Target shipping methods (Taxonomy › Setup data), e.g. UPSGround, FedEx2DayAir.</span>
        </div>
      </Card>
      <div><Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => put('/api/settings/sync', f), 'Sync settings saved').then(reload)}>Save sync settings</Btn></div>
    </div>
  );
}

export default function Settings() {
  const { data, error, loading, reload } = useLoad(() => get('/api/settings'));
  const [tab, setTab] = useState<'stage' | 'production' | 'shopify' | 'hub' | 'sync'>('stage');
  const toast = useToast();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('oauth') === 'connected') toast('Target OAuth connected');
    if (q.get('oauth') === 'error') toast(`OAuth failed: ${q.get('message')}`, 'error');
  }, [toast]);
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  return (
    <div className="page">
      <PageHead title="Settings" sub="Keys and tokens are entered here and stored encrypted in the database. They never go into the code, GitHub or Railway variables." />
      <Tabs value={tab} onChange={setTab} items={[['stage', 'Target · Stage'], ['production', 'Target · Production'], ['shopify', 'Shopify'], ['hub', 'Marketplace Hub'], ['sync', 'Sync & rules']]} />
      {(tab === 'stage' || tab === 'production') && <TargetEnvForm key={tab} env={tab} s={data} oauthCallbackUrl={data.oauthCallbackUrl} reload={reload} />}
      {tab === 'shopify' && <ShopifyForm s={data} reload={reload} />}
      {tab === 'hub' && <HubForm s={data} reload={reload} />}
      {tab === 'sync' && <SyncForm s={data} reload={reload} />}
    </div>
  );
}

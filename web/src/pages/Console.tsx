import { useState } from 'react';
import { post } from '../lib/api';
import { Btn, Card, Field, Json, PageHead, useAction } from '../components/ui';

type Preset = { label: string; api: 'sellers' | 'orders' | 'taxonomy'; method: string; path: string; query?: string; body?: any };
const PRESETS: Preset[] = [
  { label: 'Distribution centers', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/distribution_centers' },
  { label: 'Shipping methods', api: 'orders', method: 'GET', path: '/shipping_methods', query: '{"per_page":"100"}' },
  { label: 'Return policies', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/return_policies' },
  { label: 'Legalizations (item types / brands)', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/legalizations', query: '{"per_page":"100"}' },
  { label: 'Product catalog', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/products_catalog', query: '{"per_page":"100","expand":"fields,product_statuses"}' },
  { label: 'Catalog errors', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/product_catalog_errors' },
  { label: 'Report requests', api: 'sellers', method: 'GET', path: '/sellers/{seller_id}/report_requests', query: '{"per_page":"50"}' },
  { label: 'Orders (released)', api: 'orders', method: 'GET', path: '/sellers/{seller_id}/orders', query: '{"order_status":"RELEASED_FOR_SHIPMENT","per_page":"100"}' },
  { label: 'Taxonomy: item types by name', api: 'taxonomy', method: 'GET', path: '/taxonomies', query: '{"type":"ITEM_TYPE","target":"EXTERNAL","name":"shoes"}' },
  {
    label: 'Error path 2.1: invalid item type (nasal spray)', api: 'sellers', method: 'POST', path: '/sellers/{seller_id}/products',
    body: { external_id: 'ERR-ITEMTYPE-1', relationship_type: 'SA', fields: [{ name: 'item_type.name', value: 'nasal spray' }, { name: 'brands.name', value: 'Valor Fitness' }, { name: 'descriptions.title', value: 'Error path test item - invalid item type' }, { name: 'barcode.value', value: '612345678904' }] },
  },
  {
    label: 'Error path 3.1: invalid brand (Artisinal Widgets)', api: 'sellers', method: 'POST', path: '/sellers/{seller_id}/products',
    body: { external_id: 'ERR-BRAND-1', relationship_type: 'SA', fields: [{ name: 'item_type.name', value: 'REPLACE with your item type' }, { name: 'brands.name', value: 'Artisinal Widgets' }, { name: 'descriptions.title', value: 'Error path test item - invalid brand' }, { name: 'barcode.value', value: '712345678900' }] },
  },
];

export default function Console() {
  const [p, setP] = useState<Preset>(PRESETS[0]);
  const [query, setQuery] = useState(PRESETS[0].query ?? '');
  const [body, setBody] = useState('');
  const [res, setRes] = useState<any>(null);
  const { busy, run } = useAction();
  const pick = (i: number) => { const x = PRESETS[i]; setP(x); setQuery(x.query ?? ''); setBody(x.body ? JSON.stringify(x.body, null, 2) : ''); setRes(null); };
  const send = () => run('send', async () => {
    let q: any, b: any;
    try { q = query.trim() ? JSON.parse(query) : undefined; } catch { throw new Error('Query must be JSON, e.g. {"per_page":"100"}'); }
    try { b = body.trim() ? JSON.parse(body) : undefined; } catch { throw new Error('Body is not valid JSON'); }
    if (['POST', 'PUT', 'DELETE'].includes(p.method) && !confirm(`${p.method} ${p.path} on Target. Continue?`)) return;
    setRes(await post('/api/console', { api: p.api, method: p.method, path: p.path, query: q, body: b }));
  });
  return (
    <div className="page">
      <PageHead title="API console" sub="Call any Target Plus endpoint with your saved credentials (from your server, never from the browser). {seller_id} is filled in for you. Every call is recorded in the API log." />
      <div className="grid2">
        <Card title="Request">
          <div className="stack">
            <Field label="Preset"><select onChange={(e) => pick(Number(e.target.value))}>{PRESETS.map((x, i) => <option key={i} value={i}>{x.label}</option>)}</select></Field>
            <div className="row">
              <select style={{ width: 120 }} value={p.api} onChange={(e) => setP({ ...p, api: e.target.value as any })}><option value="sellers">sellers/v1</option><option value="orders">seller_orders/v1</option><option value="taxonomy">item_taxonomies/v2</option></select>
              <select style={{ width: 100 }} value={p.method} onChange={(e) => setP({ ...p, method: e.target.value })}><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
              <input style={{ flex: 1, width: 'auto' }} value={p.path} onChange={(e) => setP({ ...p, path: e.target.value })} />
            </div>
            <Field label="Query (JSON)"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='{"per_page":"100"}' /></Field>
            <Field label="Body (JSON)"><textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} /></Field>
            <div><Btn kind="primary" busy={busy === 'send'} onClick={send}>Send</Btn></div>
          </div>
        </Card>
        <Card title={res ? `Response · HTTP ${res.status}${res.total != null ? ` · ${res.total} total` : ''}` : 'Response'}>
          {res ? <>{res.error && <div className="bad small" style={{ marginBottom: 8 }}>{res.error}</div>}<Json value={res.data} /></> : <span className="muted small">Send a request to see the response.</span>}
        </Card>
      </div>
    </div>
  );
}

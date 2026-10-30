import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Field, Loading, Modal, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function Inventory() {
  const s = useLoad(() => get('/api/sync/status'));
  const stock = useLoad(() => get<any>('/api/sync/stock'));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);
  const settings = useLoad(() => get('/api/settings'));
  const { busy, run } = useAction();
  const stats = (s.data?.stats ?? []) as any[];
  const n = (kind: string, status: string) => stats.find((x) => x.kind === kind && x.status === status)?.n ?? 0;
    return (
    <div className="page">
      <PageHead title="Price & inventory" sub="Target has no bulk endpoints: each price and each item × distribution center quantity is a separate call. Updates go through a throttled queue; unchanged values are skipped.">
        <Btn busy={busy === 'rec'} onClick={() => run('rec', () => post('/api/sync/reconcile'), (r: any) => `Checked ${r.items} items in Shopify`).then(s.reload)}>Check Shopify now</Btn>
        <Btn busy={busy === 'force'} onClick={() => confirm('Re-send price and inventory for every item, even if unchanged?') && run('force', () => post('/api/sync/run', { kind: 'all', force: true }), (r: any) => `Queued ${r.queued} items`).then(s.reload)}>Re-send everything</Btn>
        <Btn kind="ghost" onClick={s.reload}>Refresh</Btn>
      </PageHead>
      <div style={{ marginBottom: 16 }}><StockCard stock={stock} sel={sel} setSel={setSel} onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems}
        busy={busy} run={run} reload={() => { stock.reload(); s.reload(); settings.reload(); }} /></div>
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Inventory queued</div><div className="value">{n('inventory', 'pending') + n('inventory', 'running')}</div></div>
        <div className="stat"><div className="label">Prices queued</div><div className="value">{n('price', 'pending') + n('price', 'running')}</div></div>
        <div className="stat"><div className="label">Done (24h)</div><div className="value">{n('inventory', 'done') + n('price', 'done') + n('logistics', 'done')}</div></div>
        <div className="stat"><div className="label">Failed (24h)</div><div className={`value ${n('inventory', 'failed') + n('price', 'failed') ? 'bad' : ''}`}>{n('inventory', 'failed') + n('price', 'failed') + n('logistics', 'failed')}</div>
          {(n('inventory', 'failed') + n('price', 'failed') + n('logistics', 'failed')) > 0 && <Btn size="sm" busy={busy === 'retry'} onClick={() => run('retry', () => post('/api/sync/retry-failed'), (r: any) => `Retrying ${r.retried}`).then(s.reload)}>Retry failed</Btn>}
        </div>
      </div>
      <Card title="Recent tasks" pad={false}>
        {s.loading && !s.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Kind</th><th>Status</th><th>Item</th><th>Result</th><th className="num">Tries</th><th>When</th></tr></thead>
            <tbody>
              {s.data.recent.length === 0 && <tr><td colSpan={6} className="empty">Nothing yet.</td></tr>}
              {s.data.recent.map((t: any) => (
                <tr key={t.id}>
                  <td>{t.kind}</td><td><Status value={t.status} /></td><td><code className="small">{t.sku ?? t.variantId}</code></td>
                  <td className="small">{t.lastError ? <span className="bad">{t.lastError}</span> : t.result?.skipped ? <span className="muted">skipped: {t.result.skipped}</span> : t.result?.sent ? <span>sent {JSON.stringify(t.result.sent)}</span> : ''}</td>
                  <td className="num">{t.attempts}</td><td className="muted small">{ago(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

const LIST_STATUS: Record<string, [string, string, string]> = {
  APPROVED: ['Live', '#dcfce7', '#166534'],
  PENDING: ['Pending', '#fef3c7', '#92400e'],
  REJECTED: ['Rejected', '#fee2e2', '#991b1b'],
  UNLISTED: ['Unlisted', '#e5e7eb', '#374151'],
  SUSPENDED: ['Suspended', '#fee2e2', '#991b1b'],
};
const Chip = ({ s }: { s?: string | null }) => {
  const [l, bg, fg] = LIST_STATUS[s ?? ''] ?? [s ?? 'Unknown', '#f3f4f6', '#4b5563'];
  return <span style={{ padding: '2px 9px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{l}</span>;
};
const usd = (n: any) => (n == null || n === '' ? '–' : `$${Number(n).toFixed(2)}`);
function priceSource(r: any): [string, string] {
  if (r.priceOverride) return ['Manual price', '#7c3aed'];
  if (r.priceRule?.mode === 'percent') return [`Web price ${r.priceRule.value > 0 ? '+' : ''}${r.priceRule.value}%`, '#2563eb'];
  if (r.priceRule?.mode === 'fixed') return [`Fixed ${usd(r.priceRule.value)}`, '#7c3aed'];
  return ['Web price', '#059669'];
}

function StockCard({ stock, sel, setSel, onlyProblems, setOnlyProblems, busy, run, reload }: any) {
  const [q, setQ] = useState('');
  const [bulkPrice, setBulkPrice] = useState(false);
  const [priceFor, setPriceFor] = useState<any>(null);
  const [stockFor, setStockFor] = useState<any>(null);
  const [view, setView] = useState<string>('all');
  const [limit, setLimit] = useState(100);
  const d = stock.data;
  if (stock.loading && !d) return <Card title="Stock & price on Target"><Loading /></Card>;
  if (!d) return null;
  const dcs: { id: string; name: string }[] = d.distributionCenters;
  const rowsAll: any[] = d.rows;
  const total = (r: any, k: 'want' | 'sent') => Object.values(r[k] ?? {}).reduce((a: number, x: any) => a + Number(x || 0), 0);
  const stockDiff = (r: any) => r.want && Object.entries(r.want).some(([dc, x]) => (r.sent ?? {})[dc] !== x);
  const pkey = (p: any) => p ? [p.list_price, p.offer_price ?? null, p.map_price ?? null].map((x) => (x == null ? '' : Number(x).toFixed(2))).join('|') : '';
  const priceDiff = (r: any) => d.priceEnabled && r.priceWant && pkey(r.priceWant) !== pkey(r.priceSent);
  const problem = (r: any) => r.task?.status === 'failed' || !r.sentAt || stockDiff(r);
  const counts: Record<string, number> = { all: rowsAll.length, APPROVED: 0, PENDING: 0, REJECTED: 0, UNLISTED: 0, instock: 0, units: 0, oos: 0, disabled: 0, problems: 0 };
  for (const r of rowsAll) {
    if (r.listingStatus && counts[r.listingStatus] !== undefined) counts[r.listingStatus]++;
    if (!total(r, 'want')) counts.oos++; else { counts.instock++; counts.units += total(r, 'want'); }
    if (r.disabled) counts.disabled++;
    if (problem(r)) counts.problems++;
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (r: any) => [r.sku, r.tcin, r.title, ...Object.values(r.options ?? {})].filter(Boolean).join(' ').toLowerCase();
  const optHit = (r: any, w: string) => Object.values(r.options ?? {}).some((x: any) => String(x).toLowerCase() === w);
  const inView = (r: any) => view === 'all' ? true : view === 'oos' ? !total(r, 'want') : view === 'instock' ? total(r, 'want') > 0 : view === 'disabled' ? r.disabled : view === 'problems' ? problem(r) : r.listingStatus === view;
  const rows = rowsAll.filter((r) => inView(r) && (!onlyProblems || problem(r)) && words.every((w) => optHit(r, w) || hay(r).includes(w)));
  const shown = rows.slice(0, limit);
  const ids = [...sel] as string[];
  const bulk = (key: string, path: string, body: any, msg: (r: any) => string) => run(key, () => post(path, { variantIds: ids, ...body }), msg).then(() => setTimeout(reload, 2500));
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const send = (only?: string[]) => run('send', () => post('/api/sync/stock/send', { variantIds: only }), (r: any) => `Sending stock for ${r.queued} SKU(s). Refresh in a few seconds.`).then(() => setTimeout(reload, 4000));

  const Tile = ({ k, label, tone }: { k: string; label: string; tone?: string }) => (
    <button onClick={() => { setView(k); setLimit(100); }} style={{ flex: '1 1 120px', textAlign: 'left', background: view === k ? '#eef2ff' : '#fff', border: `1px solid ${view === k ? '#6366f1' : '#e5e7eb'}`, borderRadius: 12, padding: '10px 12px', cursor: 'pointer' }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone ?? 'inherit' }}>{counts[k]}</div>
    </button>
  );

  return (
    <div className="stack">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Tile k="all" label="All SKUs on Target" />
        <Tile k="APPROVED" label="Live" tone="#166534" />
        <Tile k="PENDING" label="Pending review" tone="#92400e" />
        <Tile k="REJECTED" label="Rejected" tone="#991b1b" />
        <Tile k="UNLISTED" label="Unlisted" tone="#374151" />
        <Tile k="instock" label={`In stock · ${counts.units} units`} tone="#166534" />
        <Tile k="oos" label="Out of stock" />
        <Tile k="disabled" label="Disabled by you" />
        <Tile k="problems" label="Not sent / failed" tone={counts.problems ? '#b45309' : undefined} />
      </div>

      <div className="card"><div className="card-b small" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><b>Stock:</b> {d.inventoryEnabled ? <span className="ok">automatic — instant on Shopify changes, full check every {d.intervalMin} min</span> : <span className="bad">off</span>}</span>
        <span><b>Price:</b> {d.priceEnabled ? <span className="ok">automatic — Shopify web price by default (compare-at = list, price = sale), sent when it changes</span> : <span className="bad">off — nothing is sent</span>}</span>
        <span className="muted">Warehouse: {dcs.map((x) => x.name).join(', ') || '—'} · <Link to="/settings">Settings</Link></span>
      </div></div>

      <Card pad={false}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #eef0f3' }}>
          <input placeholder="Search SKU, TCIN, product, size (38), color…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(100); }} style={{ width: 320 }} />
          <span className="small muted">{rows.length} SKU(s)</span>
          <Btn size="sm" kind="ghost" onClick={() => setSel(new Set(rows.map((r) => r.variantId)))}>Select all {rows.length}</Btn>
          <span style={{ flex: 1 }} />
          <Btn size="sm" kind="ghost" onClick={reload}>Refresh</Btn>
          <Btn size="sm" kind="primary" busy={busy === 'send'} onClick={() => send()}>Send stock now (all)</Btn>
        </div>
        {sel.size > 0 && (
          <div className="sel-bar" style={{ margin: 10, flexWrap: 'wrap' }}>
            <strong>{sel.size} selected</strong>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => send(ids)}>Send stock</button>
            <button className="btn sm" onClick={() => setBulkPrice(true)}>Price…</button>
            <button className="btn sm" onClick={() => { const v = prompt('Buffer: units held back from Target for these SKUs. Empty = use the global buffer (usually 0).', ''); if (v === null) return; bulk('buf', '/api/bulk/buffer', { buffer: v.trim() === '' ? null : Number(v) }, (r) => `Buffer ${r.buffer ?? 'global'} on ${r.updated} SKU(s)`); }}>Buffer…</button>
            <button className="btn sm" onClick={() => confirm(`Stop selling ${sel.size} SKU(s)? Stock 0 is sent; the listing stays.`) && bulk('dis', '/api/bulk/disable', { disabled: true }, (r) => `${r.updated} disabled (stock 0)`)}>Disable</button>
            <button className="btn sm" onClick={() => bulk('en', '/api/bulk/disable', { disabled: false }, (r) => `${r.updated} selling again`)}>Enable</button>
            <button className="btn sm" style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626' }} onClick={() => confirm(`Unlist ${sel.size} SKU(s) on Target? (Items with a live approved version are unlisted; never-approved items are skipped.)`) && bulk('unl', '/api/bulk/unlist', {}, (r) => `${r.unlisted} unlisted${r.failed ? ` · ${r.failed} not unlisted: ${r.results.filter((x: any) => !x.ok).slice(0, 2).map((x: any) => `${x.sku} (${x.error})`).join(', ')}` : ''}`)}>Unlist</button>
            <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}
        <div className="table-wrap"><table>
          <thead><tr>
            <th style={{ width: 28 }}><input type="checkbox" checked={shown.length > 0 && shown.every((r) => sel.has(r.variantId))} onChange={(e) => { const n = new Set(sel); for (const r of shown) e.target.checked ? n.add(r.variantId) : n.delete(r.variantId); setSel(n); }} /></th>
            <th>Product</th><th>Target</th><th className="num">Shopify stock</th><th className="num">On Target</th><th>Price on Target</th><th></th>
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={7} className="empty">{rowsAll.length ? 'Nothing matches.' : 'No items on Target yet.'}</td></tr>}
            {shown.map((r) => {
              const want = total(r, 'want'), sent = total(r, 'sent');
              const [src, srcColor] = priceSource(r);
              const pw = r.priceWant, ps = r.priceSent;
              return (
                <tr key={r.variantId} style={r.disabled ? { opacity: 0.6 } : undefined}>
                  <td><input type="checkbox" checked={sel.has(r.variantId)} onChange={() => toggle(r.variantId)} /></td>
                  <td style={{ minWidth: 260 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ width: 44, height: 44, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', overflow: 'hidden', flex: '0 0 auto' }}>
                        {r.image && <img src={r.image} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
                      </div>
                      <div>
                        <Link to={`/products/${r.productId}`} style={{ fontWeight: 600 }}>{r.title || r.sku}</Link>
                        <div className="small muted">{Object.values(r.options ?? {}).join(' · ')}</div>
                        <div className="small mono muted">{r.sku}{r.tcin ? ` · TCIN ${r.tcin}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Chip s={r.listingStatus} />
                    <div className="small" style={{ marginTop: 4 }}>
                      {r.disabled && <span className="bad">Disabled · </span>}
                      {r.buffer != null && <span className="warn">Buffer {r.buffer}</span>}
                    </div>
                  </td>
                  <td className="num">{r.shopify}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <b style={{ fontSize: 15 }}>{r.sentAt ? sent : '–'}</b>
                    <div className="small">
                      {r.task?.status === 'failed' ? <span className="bad" title={r.task.error}>failed</span>
                        : r.task?.status === 'pending' || r.task?.status === 'running' ? <span className="muted">sending…</span>
                        : !r.sentAt ? <span className="bad">never sent</span>
                        : want !== sent ? <span className="warn">→ {want} next</span>
                        : <span className="muted">{ago(r.sentAt)}</span>}
                    </div>
                    {r.stockFixed && <div className="small muted">fixed by hand</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: srcColor }}>{src}</span>
                    {ps ? <div title="What Target has now">{ps.offer_price != null
                      ? <><b>{usd(ps.offer_price)}</b> <span className="small" style={{ color: '#b91c1c', fontWeight: 600 }}>sale</span> <span className="muted small">· regular <span style={{ textDecoration: 'line-through' }}>{usd(ps.list_price)}</span></span></>
                      : <b>{usd(ps.list_price)}</b>}{ps.map_price != null && <span className="muted small"> · MAP {usd(ps.map_price)}</span>}</div> : <div className="muted small">not on Target yet (price not sent)</div>}
                    <div className="small muted">Shopify {usd(r.shopifyPrice)}{r.compareAtPrice && Number(r.compareAtPrice) > Number(r.shopifyPrice) ? ` (was ${usd(r.compareAtPrice)})` : ''}</div>
                    {priceDiff(r) && pw && <div className="small warn">Sending next: {usd(pw.offer_price ?? pw.list_price)}{pw.offer_price != null ? ` sale (regular ${usd(pw.list_price)})` : ''}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setPriceFor(r)}>Price</button>{' '}
                    <button className="btn sm" onClick={() => setStockFor(r)}>Stock</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        {rows.length > shown.length && <div style={{ padding: 12, textAlign: 'center' }}><Btn size="sm" onClick={() => setLimit(limit + 200)}>Show more ({rows.length - shown.length} left)</Btn></div>}
      </Card>
      {bulkPrice && <BulkPriceModal count={sel.size} onClose={() => setBulkPrice(false)} onApply={(body) => { setBulkPrice(false); bulk('pr', '/api/bulk/price-rule', body, (r) => `Price set on ${r.updated} SKU(s)${r.sent ? ', sending to Target' : ' (price sync is off, nothing sent yet)'}`); }} />}
      {stockFor && <StockModal row={stockFor} dcs={dcs} onClose={() => setStockFor(null)} onSaved={() => { setStockFor(null); setTimeout(reload, 4000); }} />}
      {priceFor && <PriceModal row={priceFor} onClose={() => setPriceFor(null)} onSaved={() => { setPriceFor(null); setTimeout(reload, 4000); }} />}
    </div>
  );
}


function PriceModal({ row, onClose, onSaved }: { row: any; onClose: () => void; onSaved: () => void }) {
  const start = row.priceOverride ?? row.priceSent ?? {};
  const [f, setF] = useState<any>({ list_price: start.list_price ?? row.compareAtPrice ?? row.shopifyPrice ?? '', offer_price: start.offer_price ?? '', map_price: start.map_price ?? '' });
  const { busy, run } = useAction();
  return (
    <Modal title={`Target price · ${row.sku}`} onClose={onClose}>
      <div className="muted small" style={{ marginBottom: 10 }}>Shopify price {row.shopifyPrice ?? '–'}{row.compareAtPrice ? `, compare-at ${row.compareAtPrice}` : ''}. The price you set here is sent now and kept for this SKU (Shopify price changes won't overwrite it) until you click "Use Shopify price again".</div>
      <div className="row" style={{ gap: 10 }}>
        <div style={{ width: 140 }}><Field label="List price (regular)"><input type="number" step="0.01" value={f.list_price} onChange={(e) => setF({ ...f, list_price: e.target.value })} /></Field></div>
        <div style={{ width: 140 }}><Field label="Offer price (sale)"><input type="number" step="0.01" value={f.offer_price} placeholder="optional" onChange={(e) => setF({ ...f, offer_price: e.target.value })} /></Field></div>
        <div style={{ width: 140 }}><Field label="MAP price"><input type="number" step="0.01" value={f.map_price} placeholder="optional" onChange={(e) => setF({ ...f, map_price: e.target.value })} /></Field></div>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => post(`/api/variants/${row.variantId}/set-price`, f), 'Price saved and sent to Target').then((r) => r && onSaved())}>Save &amp; send to Target</Btn>
        {row.priceOverride && <Btn kind="ghost" busy={busy === 'clear'} onClick={() => run('clear', () => post(`/api/variants/${row.variantId}/set-price`, { clear: true }), 'Back to Shopify price').then((r) => r && onSaved())}>Use Shopify price again</Btn>}
      </div>
    </Modal>
  );
}

function StockModal({ row, dcs, onClose, onSaved }: { row: any; dcs: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const start = row.stockFixed ?? row.want ?? {};
  const [q, setQ] = useState<Record<string, any>>(Object.fromEntries(dcs.map((d) => [d.id, start[d.id] ?? ''])));
  const { busy, run } = useAction();
  return (
    <Modal title={`Stock on Target · ${row.sku}`} onClose={onClose}>
      <div className="muted small" style={{ marginBottom: 10 }}>Shopify stock: {row.shopify}. The numbers you set here are sent now and kept for this SKU (Shopify stock changes won't overwrite them) until you click "Use Shopify stock again".</div>
      <div className="row" style={{ gap: 10 }}>
        {dcs.map((d) => <div key={d.id} style={{ width: 160 }}><Field label={`${d.name} (${d.id})`}><input type="number" min={0} step={1} value={q[d.id]} onChange={(e) => setQ({ ...q, [d.id]: e.target.value })} /></Field></div>)}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => post(`/api/variants/${row.variantId}/set-stock`, { qty: q }), 'Stock saved and sent to Target').then((r) => r && onSaved())}>Save &amp; send to Target</Btn>
        {row.stockFixed && <Btn kind="ghost" busy={busy === 'clear'} onClick={() => run('clear', () => post(`/api/variants/${row.variantId}/set-stock`, { clear: true }), 'Back to Shopify stock').then((r) => r && onSaved())}>Use Shopify stock again</Btn>}
      </div>
    </Modal>
  );
}

function BulkPriceModal({ count, onClose, onApply }: { count: number; onClose: () => void; onApply: (b: any) => void }) {
  const [mode, setMode] = useState<'web' | 'percent' | 'fixed'>('web');
  const [value, setValue] = useState('');
  const [clearManual, setClearManual] = useState(true);
  return (
    <Modal title={`Price rule · ${count} SKU(s)`} onClose={onClose}>
      <div className="stack">
        <Field label="Target price">
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="web">Web price (Shopify price; compare-at = list, price = sale)</option>
            <option value="percent">Web price + / − percent</option>
            <option value="fixed">Fixed price</option>
          </select>
        </Field>
        {mode !== 'web' && <Field label={mode === 'percent' ? 'Percent (10 = +10%, -15 = −15%)' : 'Price (USD)'}><input type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        <label className="inline-check"><input type="checkbox" checked={clearManual} onChange={(e) => setClearManual(e.target.checked)} /> Also remove prices set by hand (“Set price”) on these SKUs</label>
        <div className="small muted">Target rules are kept: sale price is always below the list price, MAP never above list. Web price changes in Shopify are picked up right away when instant sync is on.</div>
        <div className="row"><Btn kind="primary" disabled={mode !== 'web' && value === ''} onClick={() => onApply({ mode, value: Number(value), clearManual })}>Apply</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
      </div>
    </Modal>
  );
}

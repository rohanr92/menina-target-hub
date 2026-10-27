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

function StockCard({ stock, sel, setSel, onlyProblems, setOnlyProblems, busy, run, reload }: any) {
  const d = stock.data;
  if (stock.loading && !d) return <Card title="Stock on Target"><Loading /></Card>;
  if (!d) return null;
  const dcs: { id: string; name: string }[] = d.distributionCenters;
  const mapped = Object.keys(d.locationMap ?? {}).length;
  const rowsAll: any[] = d.rows;
  const problem = (r: any) => r.task?.status === 'failed' || !r.sentAt || (r.want && Object.entries(r.want).some(([dc, q]) => (r.sent ?? {})[dc] !== q));
  const rows = onlyProblems ? rowsAll.filter(problem) : rowsAll;
  const [priceFor, setPriceFor] = useState<any>(null);
  const [stockFor, setStockFor] = useState<any>(null);
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const send = (ids?: string[]) => run('send', () => post('/api/sync/stock/send', { variantIds: ids }), (r: any) => `Sending stock for ${r.queued} SKU(s). Refresh in a few seconds.`).then(() => setTimeout(reload, 4000));
  return (
    <Card title="Stock on Target (Shopify → hub → Target)" pad={false} actions={<>
      <label className="small" style={{ marginRight: 8 }}><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only not sent / failed</label>
      {sel.size > 0 && <Btn size="sm" busy={busy === 'send'} onClick={() => send([...sel])}>Send stock for {sel.size} selected</Btn>}
      <Btn size="sm" kind="primary" busy={busy === 'send'} onClick={() => send()}>Send stock now (all)</Btn>
      <Btn size="sm" kind="ghost" onClick={reload}>Refresh</Btn>
    </>}>
      <div className="card-b small" style={{ display: 'grid', gap: 6 }}>
        <div>
          Automatic sync: <strong className={d.inventoryEnabled ? '' : 'bad'}>{d.inventoryEnabled ? `on, checks Shopify every ${d.intervalMin} min` : 'off'}</strong>{' '}
          <Btn size="sm" busy={busy === 'auto'} onClick={() => run('auto', () => post('/api/sync/auto', { on: !d.inventoryEnabled }), d.inventoryEnabled ? 'Automatic sync turned off' : 'Automatic sync turned on').then(reload)}>
            {d.inventoryEnabled ? 'Turn off' : 'Turn on automatic stock + price sync'}</Btn>
        </div>
        <div>Target distribution centers: {dcs.length ? dcs.map((x) => <code key={x.id} style={{ marginRight: 6 }}>{x.name} ({x.id})</code>) : <span className="muted">not loaded yet (loaded automatically on the first send)</span>}</div>
        <div>Shopify locations: {mapped ? `${mapped} mapped to Target DCs` : <span>not mapped, so all Shopify stock goes to the first DC{dcs[0] ? ` (${dcs[0].name})` : ''}.</span>} <Link to="/settings">Change in Settings</Link>{d.safetyStock ? ` · safety stock ${d.safetyStock} held back` : ''}</div>
        {d.planError && <div className="bad">{d.planError}</div>}
      </div>
      <div className="table-wrap"><table>
        <thead><tr>
          <th style={{ width: 28 }}><input type="checkbox" checked={rows.length > 0 && rows.every((r) => sel.has(r.variantId))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.variantId)) : new Set())} /></th>
          <th>SKU</th><th>TCIN</th><th className="num">Shopify</th>
          {dcs.map((x) => <th key={x.id} className="num">{x.name}<div className="muted small">send / on Target</div></th>)}
          <th>Status</th><th>Last sent</th><th>Price on Target</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7 + dcs.length} className="empty">{rowsAll.length ? 'Everything is sent.' : 'No items on Target yet. Send products first.'}</td></tr>}
          {rows.map((r) => (
            <tr key={r.variantId}>
              <td><input type="checkbox" checked={sel.has(r.variantId)} onChange={() => toggle(r.variantId)} /></td>
              <td><Link to={`/products/${r.productId}`}><code className="small">{r.sku}</code></Link>{!r.syncEnabled && <span className="muted small"> (sync off)</span>}</td>
              <td className="small">{r.tcin ?? ''}</td>
              <td className="num">{r.shopify}</td>
              {dcs.map((x) => {
                const w = r.want?.[x.id]; const sent = r.sent?.[x.id];
                if (w === undefined && sent === undefined) return <td key={x.id} className="num muted small">not used</td>;
                return <td key={x.id} className="num">{w ?? '–'} / <span className={sent === undefined ? 'bad' : sent !== w ? 'warn' : ''}>{sent ?? 'not sent'}</span></td>;
              })}
              <td className="small">
                {r.stockFixed && <div className="muted">fixed stock</div>}
                <button className="btn sm" style={{ marginBottom: 4 }} onClick={() => setStockFor(r)}>Set stock</button>
                <div>{r.task?.status === 'failed' ? <span className="bad">failed: {r.task.error}</span>
                  : r.task?.status === 'pending' && r.task.error ? <span className="warn">retrying: {r.task.error}</span>
                  : r.task?.status === 'pending' || r.task?.status === 'running' ? 'sending…'
                  : r.sentAt ? 'sent' : <span className="bad">never sent</span>}</div>
              </td>
              <td className="muted small">{r.sentAt ? ago(r.sentAt) : ''}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>
                {r.priceSent ? <>list {r.priceSent.list_price}{r.priceSent.offer_price != null && <> · offer {r.priceSent.offer_price}</>}{r.priceSent.map_price != null && <> · MAP {r.priceSent.map_price}</>}</> : <span className="muted">not sent</span>}
                {r.priceOverride && <span className="muted"> (fixed)</span>}{' '}
                <button className="btn sm" onClick={() => setPriceFor(r)}>Set price</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {stockFor && <StockModal row={stockFor} dcs={dcs} onClose={() => setStockFor(null)} onSaved={() => { setStockFor(null); setTimeout(reload, 4000); }} />}
      {priceFor && <PriceModal row={priceFor} onClose={() => setPriceFor(null)} onSaved={() => { setPriceFor(null); setTimeout(reload, 4000); }} />}
    </Card>
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

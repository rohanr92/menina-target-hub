import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, PageHead, Status, useAction, useLoad } from '../components/ui';

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
          <th>Status</th><th>Last sent</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6 + dcs.length} className="empty">{rowsAll.length ? 'Everything is sent.' : 'No items on Target yet. Send products first.'}</td></tr>}
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
                {r.task?.status === 'failed' ? <span className="bad">failed: {r.task.error}</span>
                  : r.task?.status === 'pending' && r.task.error ? <span className="warn">retrying: {r.task.error}</span>
                  : r.task?.status === 'pending' || r.task?.status === 'running' ? 'sending…'
                  : r.sentAt ? 'sent' : <span className="bad">never sent</span>}
              </td>
              <td className="muted small">{r.sentAt ? ago(r.sentAt) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}

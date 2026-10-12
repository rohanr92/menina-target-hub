import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function Inventory() {
  const s = useLoad(() => get('/api/sync/status'));
  const settings = useLoad(() => get('/api/settings'));
  const { busy, run } = useAction();
  const stats = (s.data?.stats ?? []) as any[];
  const n = (kind: string, status: string) => stats.find((x) => x.kind === kind && x.status === status)?.n ?? 0;
  const sync = settings.data?.sync;
  return (
    <div className="page">
      <PageHead title="Price & inventory" sub="Target has no bulk endpoints: each price and each item × distribution center quantity is a separate call. Updates go through a throttled queue; unchanged values are skipped.">
        <Btn busy={busy === 'rec'} onClick={() => run('rec', () => post('/api/sync/reconcile'), (r: any) => `Checked ${r.items} items in Shopify`).then(s.reload)}>Check Shopify now</Btn>
        <Btn busy={busy === 'force'} onClick={() => confirm('Re-send price and inventory for every item, even if unchanged?') && run('force', () => post('/api/sync/run', { kind: 'all', force: true }), (r: any) => `Queued ${r.queued} items`).then(s.reload)}>Re-send everything</Btn>
        <Btn kind="ghost" onClick={s.reload}>Refresh</Btn>
      </PageHead>
      {sync && (!sync.inventoryEnabled || !sync.priceEnabled) && (
        <div className="card" style={{ marginBottom: 16 }}><div className="card-b small">
          Automatic sync is <strong>{sync.inventoryEnabled ? 'on' : 'off'}</strong> for inventory and <strong>{sync.priceEnabled ? 'on' : 'off'}</strong> for prices. Manual sends from product pages always work. <Link to="/settings">Change in Settings › Sync & rules</Link>.
        </div></div>
      )}
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
                  <td>{t.kind}</td><td><Status value={t.status} /></td><td><code className="small">{t.variantId}</code></td>
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

import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, ErrorBox, Loading, Status, useAction, useLoad } from '../components/ui';

const STEPS: [string, string, string][] = [
  ['targetCredentials', 'Add Target API credentials', '/settings'],
  ['shopify', 'Connect Shopify', '/settings'],
  ['itemTypes', 'Load allowed item types', '/taxonomy'],
  ['attributes', 'Pull attributes + value lists', '/taxonomy'],
  ['distributionCenters', 'Pull warehouses + shipping methods', '/taxonomy'],
  ['products', 'Import products from Shopify', '/products'],
  ['mapped', 'Set item types + map attributes', '/products'],
  ['onTarget', 'Send your first items to Target', '/products'],
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Dashboard() {
  const { data, error, loading, reload } = useLoad(() => get('/api/dashboard'));
  const { busy, run } = useAction();
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  const d = data!;
  const openOrders = d.orders.released + d.orders.acknowledged + d.orders.partial;
  const attention = d.items.rejected + d.items.suspended;
  const tpPct = d.testPlan.partner ? Math.round((d.testPlan.done / d.testPlan.partner) * 100) : 0;
  const setupDone = STEPS.filter(([k]) => d.setup[k]).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting()}, Yago</h1>
          <p>Here’s what’s happening on Target Plus ({d.env === 'stage' ? 'stage, testing' : 'production'})</p>
        </div>
        <div className="row">
          <Btn busy={busy === 'orders'} onClick={() => run('orders', () => post('/api/orders/poll'), (r: any) => `${r.released} released order(s), ${r.created} new`).then(reload)}>Pull orders</Btn>
          <Btn kind="primary" busy={busy === 'sync'} onClick={() => run('sync', () => post('/api/sync/reconcile'), (r: any) => `Checked ${r.items} items`).then(reload)}>Sync stock & price</Btn>
        </div>
      </div>

      <div className="section-label">Take action</div>
      <div className="grid4" style={{ marginBottom: 20 }}>
        <Link to="/orders" className="action tone-blue"><div className="num">{openOrders}</div><div><div className="t">Orders to process</div><div className="s">{d.orders.late ? `${d.orders.late} late · ` : ''}Acknowledge & ship</div></div></Link>
        <Link to="/listing-errors" className={`action ${attention ? 'tone-red' : 'tone-orange'}`}><div className="num">{attention}</div><div><div className="t">Items to fix</div><div className="s">Rejected or suspended</div></div></Link>
        <Link to="/products" className="action tone-green"><div className="num">{d.items.on_target}</div><div><div className="t">Items on Target</div><div className="s">{d.items.approved} approved · {d.items.pending} pending</div></div></Link>
        {d.env === 'stage'
          ? <Link to="/test-plan" className="action tone-violet"><div className="num">{tpPct}%</div><div><div className="t">Test plan</div><div className="s">{d.testPlan.done} of {d.testPlan.partner} scenarios done</div></div></Link>
          : <Link to="/bulk" className="action tone-violet"><div className="num">{d.items.unlisted}</div><div><div className="t">Unlisted items</div><div className="s">Listed again only when you send them</div></div></Link>}
      </div>

      <div className="grid4" style={{ marginBottom: 20 }}>
        <div className="stat"><div className="label">Products in hub</div><div className="value">{d.products.total}</div><div className="sub">{d.products.unmapped} without item type</div></div>
        <div className="stat"><div className="label">Ship today</div><div className="value">{d.orders.due_soon}</div><div className="sub">due in the next 24h</div></div>
        <div className="stat"><div className="label">API errors</div><div className="value">{d.errors24h}</div><div className="sub">last 24 hours · <Link to="/logs">view log</Link></div></div>
        <div className="stat"><div className="label">Failed syncs</div><div className="value">{d.failedTasks}</div><div className="sub">last 24 hours · <Link to="/inventory">review</Link></div></div>
      </div>

      <div className={d.env === 'stage' ? 'grid3' : 'grid2'}>
        <Card title="Items on Target">
          <div className="list-row"><span>Total</span><Link to="/target-catalog">{d.items.on_target}</Link></div>
          <div className="list-row"><span>Approved</span><span className="v">{d.items.approved}</span></div>
          <div className="list-row"><span>Pending review</span><span className="v">{d.items.pending}</span></div>
          <div className="list-row"><span>Rejected</span><span className="v" style={{ color: d.items.rejected ? 'var(--bad)' : undefined }}>{d.items.rejected}</span></div>
          <div className="list-row"><span>Unlisted</span><span className="v">{d.items.unlisted}</span></div>
          <div className="list-row"><span>Suspended</span><span className="v">{d.items.suspended}</span></div>
        </Card>
        {d.env === 'stage' && <Card title={`Setup · ${setupDone}/${STEPS.length}`}>
          <div className="progress" style={{ marginBottom: 10 }}><div style={{ width: `${(setupDone / STEPS.length) * 100}%` }} /></div>
          <div className="checklist">
            {STEPS.map(([k, label, to]) => (
              <Link key={k} to={to}><span className={`check ${d.setup[k] ? 'done' : ''}`} /><span className={d.setup[k] ? 'muted' : ''}>{label}</span></Link>
            ))}
          </div>
        </Card>}
        <Card title="Automation">
          <div className="list-row"><span>Order pull</span><span className="v">{d.sync.ordersEnabled ? `every ${d.sync.ordersIntervalMin} min` : 'off'}</span></div>
          <div className="list-row"><span>Stock sync</span><span className="v">{d.sync.inventoryEnabled ? 'instant (Shopify webhooks) + check every ' + d.sync.inventoryIntervalMin + ' min' : 'off'}</span></div>
          <div className="list-row"><span>Price sync</span><span className="v">{d.sync.priceEnabled ? 'on' : 'off'}</span></div>
          <div className="list-row"><span>Auto acknowledge</span><span className="v">{d.sync.autoAcknowledge ? 'on' : 'off'}</span></div>
          <div className="list-row"><span>Orders into Shopify</span><span className="v">{d.sync.pushOrdersToShopify ? 'on' : 'off'}</span></div>
          <div style={{ marginTop: 10 }}><Link to="/settings" className="small">Change in Settings →</Link></div>
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Background jobs" pad={false}>
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Last run</th><th>Result</th></tr></thead>
            <tbody>
              {d.jobs.length === 0 && <tr><td colSpan={4} className="empty">No jobs yet</td></tr>}
              {d.jobs.map((j: any) => (
                <tr key={j.job}><td><strong>{j.job}</strong></td><td><Status value={j.status} /></td><td className="muted">{ago(j.started_at)}</td><td className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.message}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

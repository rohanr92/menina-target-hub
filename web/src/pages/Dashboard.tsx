import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { money } from '../lib/format';
import { Btn, Card, ErrorBox, Loading, useAction, useLoad } from '../components/ui';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
const short = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${Math.round(n)}`);

function SalesChart({ daily, metric }: { daily: { day: string; orders: number; sales: number }[]; metric: 'sales' | 'orders' }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = daily.map((d) => (metric === 'sales' ? d.sales : d.orders));
  const max = Math.max(1, ...vals);
  const W = 720, H = 200, pad = 26, bw = (W - pad) / daily.length;
  const h = hover != null ? daily[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H + 24}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={pad} x2={W} y1={H - t * (H - 10)} y2={H - t * (H - 10)} stroke="#eef0f4" />
            <text x={0} y={H - t * (H - 10) + 4} fontSize="10" fill="#94a3b8">{metric === 'sales' ? short(max * t) : Math.round(max * t)}</text>
          </g>
        ))}
        {daily.map((d, i) => {
          const v = vals[i]; const bh = (v / max) * (H - 10);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={pad + i * bw + bw * 0.18} y={H - bh} width={bw * 0.64} height={Math.max(bh, v ? 2 : 0)} rx={3} fill={hover === i ? '#4338ca' : '#6366f1'} opacity={hover == null || hover === i ? 1 : 0.55} />
              {(i % 5 === 0 || i === daily.length - 1) && <text x={pad + i * bw + bw / 2} y={H + 16} fontSize="10" fill="#94a3b8" textAnchor="middle">{new Date(d.day + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div style={{ position: 'absolute', top: 0, right: 0, background: '#0f172a', color: '#fff', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
          <b>{new Date(h.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b> · {money(h.sales)} · {h.orders} order{h.orders === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

const statusChip = (s: string) => {
  const m: Record<string, [string, string, string]> = {
    RELEASED_FOR_SHIPMENT: ['New', '#fef3c7', '#92400e'], ACKNOWLEDGED_BY_SELLER: ['Unfulfilled', '#fef9c3', '#854d0e'],
    PARTIALLY_SHIPPED: ['Partial', '#ffedd5', '#9a3412'], SHIPPED: ['Fulfilled', '#e5e7eb', '#374151'], CANCELED: ['Canceled', '#fee2e2', '#991b1b'],
  };
  const [l, bg, fg] = m[s] ?? [s, '#f3f4f6', '#374151'];
  return <span style={{ padding: '2px 9px', borderRadius: 999, background: bg, color: fg, fontSize: 11.5, fontWeight: 600 }}>{l}</span>;
};

export default function Dashboard() {
  const v2 = useLoad(() => get('/api/dashboard/v2'));
  const v1 = useLoad(() => get('/api/dashboard'));
  const { busy, run } = useAction();
  const [metric, setMetric] = useState<'sales' | 'orders'>('sales');
  const nav = useNavigate();
  if (v2.loading && !v2.data) return <div className="page"><Loading /></div>;
  if (v2.error) return <div className="page"><ErrorBox error={v2.error} /></div>;
  const d: any = v2.data; const k = d.kpi; const old: any = v1.data;
  const reload = () => { v2.reload(); v1.reload(); };
  const wow = k.sales_prev7 ? Math.round(((k.sales7 - k.sales_prev7) / k.sales_prev7) * 100) : null;
  const crit = (d.alerts ?? []).filter((a: any) => a.severity === 'critical');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting()}, Yago</h1>
          <p>Target Plus · {old?.env === 'stage' ? 'stage (testing)' : 'live'} · {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
        <div className="row">
          <Btn busy={busy === 'orders'} onClick={() => run('orders', () => post('/api/orders/poll'), (r: any) => `${r.released} released order(s), ${r.created} new`).then(reload)}>Pull orders</Btn>
          <Btn kind="primary" busy={busy === 'sync'} onClick={() => run('sync', () => post('/api/sync/reconcile'), (r: any) => `Checked ${r.items} items`).then(reload)}>Sync stock & price</Btn>
        </div>
      </div>

      {(crit.length > 0 || d.holds > 0) && (
        <div style={{ background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 14, padding: '12px 16px', marginBottom: 18 }}>
          {crit.slice(0, 3).map((a: any) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', padding: '3px 0' }}><span className="sev critical" />{a.link ? <Link to={a.link} style={{ fontWeight: 600 }}>{a.title}</Link> : <b>{a.title}</b>}</div>
          ))}
          {d.holds > 0 && <div style={{ display: 'flex', alignItems: 'center', padding: '3px 0' }}><span className="sev warning" /><Link to="/inventory" style={{ fontWeight: 600 }}>{d.holds} price drop(s) waiting for your approval</Link></div>}
          {(crit.length > 3) && <Link to="/alerts" className="small">See all alerts →</Link>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
        <div className="kpi"><div className="l">Sales today</div><div className="v">{money(k.sales_today)}</div><div className="s">{k.orders_today} order{k.orders_today === 1 ? '' : 's'}</div></div>
        <div className="kpi"><div className="l">Last 7 days</div><div className="v">{money(k.sales7)}</div><div className="s">{wow == null ? 'no data for the week before' : <><span className={wow >= 0 ? 'up' : 'down'}>{wow >= 0 ? '▲' : '▼'} {Math.abs(wow)}%</span> vs previous 7 days</>}</div></div>
        <div className="kpi"><div className="l">Last 30 days</div><div className="v">{money(k.sales30)}</div><div className="s">{k.orders30} orders · {k.units30} units{k.orders30 ? ` · avg ${money(k.sales30 / k.orders30)}` : ''}</div></div>
        <button className="kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => nav('/orders')}>
          <div className="l">Orders to ship</div><div className="v" style={{ color: k.late ? '#b91c1c' : undefined }}>{k.open}</div>
          <div className="s">{k.late ? <span className="down">{k.late} late</span> : 'none late'}{k.due24 ? ` · ${k.due24} due in 24h` : ''}</div>
        </button>
        <button className="kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => nav('/inventory')}>
          <div className="l">Live on Target</div><div className="v">{d.items.live}</div>
          <div className="s">{d.items.live_in_stock} in stock · {d.items.rejected ? <span className="down">{d.items.rejected} rejected</span> : '0 rejected'}</div>
        </button>
      </div>

      <Card title={<div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <span>{metric === 'sales' ? 'Sales' : 'Orders'} · last 30 days</span><span style={{ flex: 1 }} />
        <div className="seg" style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
          {(['sales', 'orders'] as const).map((m) => <button key={m} onClick={() => setMetric(m)} style={{ border: 0, cursor: 'pointer', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: metric === m ? '#fff' : 'transparent', boxShadow: metric === m ? '0 1px 2px rgba(0,0,0,.08)' : undefined }}>{m === 'sales' ? 'Sales' : 'Orders'}</button>)}
        </div>
      </div>}>
        <SalesChart daily={d.daily} metric={metric} />
      </Card>

      <div className="grid2" style={{ marginTop: 18 }}>
        <Card title="Best sellers · 30 days">
          {d.topSellers.length === 0 ? <div className="empty small">No sales in the last 30 days yet.</div> : d.topSellers.map((t: any, i: number) => (
            <div className="mini-row" key={t.tcin ?? i}>
              <span className="small muted" style={{ width: 16 }}>{i + 1}</span>
              {t.image ? <img className="mini-thumb" src={t.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : <div className="mini-thumb" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.productId ? <Link to={`/products/${t.productId}`}>{t.title}</Link> : t.title}</div>
                <div className="small muted">{t.options || t.sku}{t.inventory != null ? ` · ${t.inventory} left` : ''}</div>
              </div>
              <div style={{ textAlign: 'right' }}><div style={{ fontWeight: 700 }}>{t.units} sold</div><div className="small muted">{money(t.sales)}</div></div>
            </div>
          ))}
        </Card>
        <Card title="Running low on selling items">
          {d.lowStock.length === 0 ? <div className="empty small">No selling item is running low. 👍</div> : d.lowStock.map((t: any, i: number) => (
            <div className="mini-row" key={i}>
              {t.image ? <img className="mini-thumb" src={t.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : <div className="mini-thumb" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.product_id ? <Link to={`/products/${t.product_id}`}>{t.title}</Link> : t.title}</div>
                <div className="small muted">{t.options || t.sku} · sold {t.units} in 30 days</div>
              </div>
              <span style={{ padding: '2px 9px', borderRadius: 999, background: t.inventory > 0 ? '#ffedd5' : '#fee2e2', color: t.inventory > 0 ? '#9a3412' : '#991b1b', fontSize: 12, fontWeight: 700 }}>{t.inventory > 0 ? `${t.inventory} left` : 'Sold out'}</span>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid3" style={{ marginTop: 18 }}>
        <Card title="Latest orders" actions={<Link to="/orders" className="small">All orders →</Link>}>
          {d.recent.length === 0 ? <div className="empty small">No orders yet.</div> : d.recent.map((o: any) => (
            <div className="mini-row" key={o.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/orders/${encodeURIComponent(o.id)}`)}>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>#{o.order_number}</div><div className="small muted">{o.order_date ? new Date(o.order_date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</div></div>
              {statusChip(o.status)}<b style={{ width: 80, textAlign: 'right' }}>{money(o.total)}</b>
            </div>
          ))}
        </Card>
        <Card title="Items on Target" actions={<Link to="/inventory" className="small">Manage →</Link>}>
          {[['Live', d.items.live, '#16a34a'], ['Pending review', d.items.pending, '#d97706'], ['Rejected', d.items.rejected, '#dc2626'], ['Unlisted', d.items.unlisted, '#6b7280']].map(([l, n, c]: any) => {
            const tot = Math.max(1, d.items.live + d.items.pending + d.items.rejected + d.items.unlisted);
            return (
              <div key={l} style={{ padding: '7px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{l}</span><b>{n}</b></div>
                <div style={{ height: 6, background: '#f1f5f9', borderRadius: 6, marginTop: 4 }}><div style={{ width: `${(n / tot) * 100}%`, height: '100%', background: c, borderRadius: 6 }} /></div>
              </div>
            );
          })}
        </Card>
        <Card title="Automation" actions={<Link to="/settings" className="small">Settings →</Link>}>
          {[['Orders pulled & acknowledged', d.sync.orders], ['Orders created in Shopify', d.sync.shopifyOrders], ['Stock sync (instant)', d.sync.inventory], ['Price sync', d.sync.price]].map(([l, on]: any) => (
            <div key={l} className="list-row"><span>{l}</span><span style={{ fontWeight: 700, color: on ? '#16a34a' : '#9ca3af' }}>{on ? '● On' : '○ Off'}</span></div>
          ))}
          {old && <div className="list-row"><span>Sync problems (24h)</span><span className="v" style={{ color: old.failedTasks ? '#b91c1c' : undefined }}>{old.failedTasks}</span></div>}
          {old && <div className="list-row"><span>API errors (24h)</span><span className="v">{old.errors24h} · <Link to="/logs">log</Link></span></div>}
        </Card>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { money } from '../lib/format';
import { Btn, Card, Loading, PageHead, useAction, useLoad } from '../components/ui';

const OPEN = ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED'];

const fmtDate = (d?: string | null) => {
  if (!d) return '—';
  const x = new Date(d);
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  const time = x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (x.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (x.toDateString() === y.toDateString()) return `Yesterday at ${time}`;
  return x.toLocaleDateString([], { month: 'short', day: 'numeric', year: x.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + ` at ${time}`;
};
const until = (d?: string | null) => {
  if (!d) return null;
  const ms = new Date(d).getTime() - Date.now();
  const h = Math.round(Math.abs(ms) / 36e5);
  const txt = h < 1 ? 'less than 1h' : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  return { late: ms < 0, soon: ms >= 0 && ms < 24 * 36e5, txt };
};

/** Shopify-style status chip: what the warehouse needs to know at a glance. */
function Fulfillment({ o }: { o: any }) {
  const units = o.units || 0;
  const map: Record<string, [string, string, string]> = {
    RELEASED_FOR_SHIPMENT: ['New · Unfulfilled', '#fef3c7', '#92400e'],
    ACKNOWLEDGED_BY_SELLER: ['Unfulfilled', '#fef9c3', '#854d0e'],
    PARTIALLY_SHIPPED: [`Partially fulfilled · ${o.shippedUnits}/${units}`, '#ffedd5', '#9a3412'],
    SHIPPED: [o.canceledUnits ? `Fulfilled · ${o.canceledUnits} canceled` : 'Fulfilled', '#e5e7eb', '#374151'],
    CANCELED: ['Canceled', '#fee2e2', '#991b1b'],
  };
  const [label, bg, fg] = map[o.status] ?? [o.status, '#e5e7eb', '#374151'];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
    <span style={{ width: 7, height: 7, borderRadius: 7, background: fg, opacity: o.status === 'SHIPPED' ? 0.5 : 1 }} />{label}
  </span>;
}

function Kpi({ label, value, tone, onClick, active }: { label: string; value: React.ReactNode; tone?: 'bad' | 'warn' | 'ok'; onClick?: () => void; active?: boolean }) {
  const color = tone === 'bad' ? '#b91c1c' : tone === 'warn' ? '#b45309' : tone === 'ok' ? '#15803d' : 'inherit';
  return (
    <button onClick={onClick} style={{ textAlign: 'left', flex: '1 1 150px', background: '#fff', border: `1px solid ${active ? '#4f46e5' : '#e5e7eb'}`, borderRadius: 12, padding: '12px 14px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </button>
  );
}

export default function Orders() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(qLive.trim()), 350); return () => clearTimeout(t); }, [qLive]);
  const list = useLoad(() => get(`/api/orders?status=${status === 'late' || status === 'today' ? 'open' : status}&q=${encodeURIComponent(q)}`), [status, q]);
  const counts = useLoad(() => get('/api/orders/counts'), []);
  const { busy, run } = useAction();
  const nav = useNavigate();
  const c: any = counts.data ?? {};
  const reload = () => { list.reload(); counts.reload(); };

  let rows: any[] = list.data ?? [];
  if (status === 'late') rows = rows.filter((o) => until(o.requestedShipmentDate)?.late);
  if (status === 'today') rows = rows.filter((o) => until(o.requestedShipmentDate)?.soon);

  const tabs: [string, string, number | undefined][] = [
    ['', 'All', c.total], ['open', 'To ship', c.open], ['RELEASED_FOR_SHIPMENT', 'New', c.released], ['PARTIALLY_SHIPPED', 'Partially fulfilled', c.partially],
    ['SHIPPED', 'Fulfilled', c.shipped], ['CANCELED', 'Canceled', c.canceled],
  ];

  return (
    <div className="page">
      <PageHead title="Orders" sub="Target Plus orders. New orders are acknowledged and created in Shopify automatically; fulfill in Shopify and the tracking goes to Target.">
        <Btn busy={busy === 'import'} onClick={() => run('import', () => post('/api/orders/import'), (r: any) => `${r.imported} orders loaded${r.perStatus ? ' · ' + Object.entries(r.perStatus).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join(', ') : ''}`).then(reload)}>Load all orders</Btn>
        <Btn kind="primary" busy={busy === 'poll'} onClick={() => run('poll', () => post('/api/orders/poll'), (r: any) => `${r.released} released · ${r.created} new · ${r.acknowledged} acknowledged`).then(reload)}>Pull new orders</Btn>
      </PageHead>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi label="To ship" value={c.open ?? '–'} tone={c.open ? 'warn' : undefined} active={status === 'open'} onClick={() => setStatus('open')} />
        <Kpi label="Late (past ship-by)" value={c.late ?? '–'} tone={c.late ? 'bad' : 'ok'} active={status === 'late'} onClick={() => setStatus('late')} />
        <Kpi label="Ship within 24h" value={c.ship_today ?? '–'} tone={c.ship_today ? 'warn' : undefined} active={status === 'today'} onClick={() => setStatus('today')} />
        <Kpi label="Orders · last 7 days" value={c.last7 ?? '–'} />
        <Kpi label="Sales · last 30 days" value={c.sales30 != null ? money(c.sales30) : '–'} />
      </div>

      <Card pad={false}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderBottom: '1px solid #eef0f3', flexWrap: 'wrap' }}>
          {tabs.map(([k, label, n]) => (
            <button key={k} onClick={() => setStatus(k)} style={{ border: 0, cursor: 'pointer', padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: status === k ? '#eef2ff' : 'transparent', color: status === k ? '#3730a3' : '#4b5563' }}>
              {label}{n != null && <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 7px', borderRadius: 999, background: status === k ? '#c7d2fe' : '#f3f4f6' }}>{n}</span>}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <input style={{ width: 280 }} placeholder="Search order #, SKU, TCIN…" value={qLive} onChange={(e) => setQLive(e.target.value)} />
        </div>
        {list.loading && !list.data ? <Loading /> : (
          <div className="table-wrap"><table className="orders-table">
            <thead><tr>
              <th>Order</th><th>Date</th><th>Items</th><th>Fulfillment</th><th>Ship by</th><th>Tracking</th><th className="num">Total</th><th>Shopify</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="empty">No orders here.</td></tr>}
              {rows.map((o: any) => {
                const u = OPEN.includes(o.status) ? until(o.requestedShipmentDate) : null;
                const first = o.items?.[0];
                const more = (o.lines ?? 0) - 1;
                return (
                  <tr key={o.id} className="click" onClick={() => nav(`/orders/${encodeURIComponent(o.id)}`)} style={o.status === 'RELEASED_FOR_SHIPMENT' ? { background: '#fffbeb' } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <strong>#{o.orderNumber}</strong>
                      {o.lastError && <div className="small bad" title={o.lastError} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>⚠ {o.lastError}</div>}
                    </td>
                    <td className="small" style={{ whiteSpace: 'nowrap', color: '#4b5563' }}>{fmtDate(o.orderDate)}</td>
                    <td style={{ minWidth: 260 }}>
                      {first ? (
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <div style={{ position: 'relative', width: 44, height: 44, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', overflow: 'hidden', flex: '0 0 auto' }}>
                            {first.image && <img src={first.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
                            {o.units > 1 && <span style={{ position: 'absolute', right: 2, top: 2, background: '#111827', color: '#fff', fontSize: 10, borderRadius: 8, padding: '0 5px' }}>{o.units}</span>}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }} title={first.title}>{first.title}</div>
                            <div className="small muted">{[first.options, first.sku].filter(Boolean).join(' · ')}{more > 0 ? ` · +${more} more` : ''}</div>
                          </div>
                        </div>
                      ) : <span className="muted small">{o.units} unit(s)</span>}
                    </td>
                    <td><Fulfillment o={o} /></td>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {u ? <span style={{ fontWeight: 600, color: u.late ? '#b91c1c' : u.soon ? '#b45309' : '#374151' }}>{u.late ? `Late ${u.txt}` : `in ${u.txt}`}</span> : <span className="muted">{fmtDate(o.requestedShipmentDate).replace(/ at .*/, '')}</span>}
                    </td>
                    <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{o.tracking ? <>{o.tracking.method && <div className="muted" style={{ fontFamily: 'inherit' }}>{o.tracking.method}</div>}{o.tracking.number}</> : <span className="muted">—</span>}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(o.total)}</td>
                    <td className="small">{o.shopifyOrderName ? <span style={{ padding: '2px 8px', borderRadius: 6, background: '#ecfdf5', color: '#047857', fontWeight: 600 }}>{o.shopifyOrderName}</span> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        {rows.length > 0 && <div className="small muted" style={{ padding: '10px 14px', borderTop: '1px solid #eef0f3' }}>{rows.length} order{rows.length === 1 ? '' : 's'}{status === '' && c.total > rows.length ? ` (newest ${rows.length} of ${c.total})` : ''}</div>}
      </Card>
    </div>
  );
}

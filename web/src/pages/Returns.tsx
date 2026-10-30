import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { Card, ErrorBox, Loading, PageHead, Tabs, useLoad } from '../components/ui';

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function Returns() {
  const [tab, setTab] = useState<'returns' | 'disputes'>('returns');
  const [q, setQ] = useState('');
  const r = useLoad(() => get('/api/returns/v2'), []);
  const disp = useLoad(() => (tab === 'disputes' ? get('/api/returns/disputes') : Promise.resolve(null)), [tab]);
  const d: any = r.data;
  const items: any[] = (d?.items ?? []).filter((x: any) => !q || [x.title, x.sku, x.orderNumber, x.tcin, x.reason].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()));
  const maxReason = Math.max(1, ...((d?.reasons ?? []).map((x: any) => x[1])));
  return (
    <div className="page">
      <PageHead title="Returns" sub="Target guest returns. Returns of orders the hub created are recorded in Shopify as a refund and the order is tagged “Target return”." />
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
            <div className="kpi"><div className="l">Returns</div><div className="v">{d.stats.returns}</div><div className="s">{d.stats.units} unit(s) in total</div></div>
            <div className="kpi"><div className="l">Return rate · 90 days</div><div className="v" style={{ color: (d.stats.rate90 ?? 0) > 10 ? '#b91c1c' : undefined }}>{d.stats.rate90 == null ? '—' : `${d.stats.rate90}%`}</div><div className="s">{d.stats.last90} returned of {d.stats.sold90} sold</div></div>
            <div className="kpi"><div className="l">Recorded in Shopify</div><div className="v">{d.stats.inShopify}</div><div className="s">refund + “Target return” tag</div></div>
          </div>
          <div className="grid2" style={{ marginBottom: 18 }}>
            <Card title="Why customers return">
              {d.reasons.length === 0 ? <div className="empty small">No returns yet.</div> : d.reasons.slice(0, 6).map(([reason, n]: any) => (
                <div key={reason} style={{ padding: '6px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{String(reason).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span><b>{n}</b></div>
                  <div style={{ height: 6, background: '#f1f5f9', borderRadius: 6, marginTop: 4 }}><div style={{ width: `${(n / maxReason) * 100}%`, height: '100%', background: '#6366f1', borderRadius: 6 }} /></div>
                </div>
              ))}
            </Card>
            <Card title="Most returned products">
              {d.topReturned.length === 0 ? <div className="empty small">No returns yet.</div> : d.topReturned.map((p: any, i: number) => (
                <div className="mini-row" key={i}>
                  {p.image ? <img className="mini-thumb" src={p.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : <div className="mini-thumb" />}
                  <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13.5 }}>{p.productId ? <Link to={`/products/${p.productId}`}>{p.title}</Link> : p.title}</div>
                  <b>{p.units}</b>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}
      <div className="row between" style={{ marginBottom: 10 }}>
        <Tabs value={tab} onChange={setTab} items={[['returns', 'Returns'], ['disputes', 'Return disputes']]} />
        {tab === 'returns' && <input style={{ width: 260 }} placeholder="Search product, SKU, order, reason…" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      <Card pad={false}>
        {tab === 'returns' ? (!d ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Product</th><th>Order</th><th className="num">Qty</th><th>Reason</th><th>Returned</th><th>Status</th><th>Shopify</th></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={7} className="empty">No returns.</td></tr>}
              {items.map((x) => (
                <tr key={x.id}>
                  <td style={{ minWidth: 240 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {x.image ? <img className="mini-thumb" src={x.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : <div className="mini-thumb" />}
                      <div><div style={{ fontWeight: 600 }}>{x.productId ? <Link to={`/products/${x.productId}`}>{x.title}</Link> : x.title}</div><div className="small muted">{[x.options, x.sku].filter(Boolean).join(' · ')}</div></div>
                    </div>
                  </td>
                  <td className="small">{x.orderId ? <Link to={`/orders/${encodeURIComponent(x.orderId)}`}>#{x.orderNumber}</Link> : `#${x.orderNumber ?? '—'}`}</td>
                  <td className="num">{x.quantity}</td>
                  <td className="small">{String(x.reason ?? '—').replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmt(x.date)}{x.tracking?.length ? <div className="muted mono">{x.tracking[0]}</div> : null}</td>
                  <td className="small">{[x.financial, x.physical].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="small">{x.inShopify ? <span style={{ padding: '2px 8px', borderRadius: 6, background: '#ecfdf5', color: '#047857', fontWeight: 600 }}>Refunded{x.shopifyOrder ? ` · ${x.shopifyOrder}` : ''}</span> : x.shopifyOrder ? <span className="warn">pending</span> : <span className="muted">not a hub order</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )) : (disp.loading ? <Loading /> : disp.error ? <ErrorBox error={disp.error} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Case</th><th>Return order</th><th>Order</th><th>Reason</th><th>Judgement</th><th>Final response</th><th>Updated</th></tr></thead>
            <tbody>
              {(disp.data ?? []).length === 0 && <tr><td colSpan={7} className="empty">No disputes.</td></tr>}
              {(disp.data ?? []).map((x: any) => <tr key={x.id}><td className="mono small">{x.case_id}</td><td>{x.return_order_number}</td><td>{x.order_id}</td><td>{x.dispute_reason}</td><td>{x.judgement}</td><td>{x.final_response}</td><td className="small">{fmt(x.last_modified)}</td></tr>)}
            </tbody>
          </table></div>
        ))}
      </Card>
    </div>
  );
}

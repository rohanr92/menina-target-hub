import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dt, money } from '../lib/format';
import { Btn, Card, Loading, PageHead, Status, Tabs, useAction, useLoad } from '../components/ui';

export default function Orders() {
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const list = useLoad(() => get(`/api/orders?status=${status}&q=${encodeURIComponent(q)}`), [status, q]);
  const { busy, run } = useAction();
  const nav = useNavigate();
  return (
    <div className="page">
      <PageHead title="Orders" sub="New orders arrive as RELEASED_FOR_SHIPMENT. Acknowledge quickly, ship or cancel at line level with a Target shipping method, and send tracking for every line.">
        <Btn busy={busy === 'import'} onClick={() => run('import', () => post('/api/orders/import'), (r: any) => `${r.imported} orders loaded`).then(list.reload)}>Load all orders</Btn>
        <Btn kind="primary" busy={busy === 'poll'} onClick={() => run('poll', () => post('/api/orders/poll'), (r: any) => `${r.released} released · ${r.created} new · ${r.acknowledged} acknowledged`).then(list.reload)}>Pull new orders</Btn>
      </PageHead>
      <div className="row between">
        <Tabs value={status} onChange={setStatus} items={[['open', 'Open'], ['RELEASED_FOR_SHIPMENT', 'Released'], ['ACKNOWLEDGED_BY_SELLER', 'Acknowledged'], ['PARTIALLY_SHIPPED', 'Partially shipped'], ['SHIPPED', 'Shipped'], ['CANCELED', 'Canceled'], ['', 'All']]} />
        <input style={{ width: 220 }} placeholder="Order number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Order</th><th>Status</th><th>Ordered</th><th>Ship by</th><th>Deliver by</th><th>Customer</th><th className="num">Units</th><th className="num">Total</th><th>Shopify</th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={9} className="empty">No orders.</td></tr>}
              {list.data.map((o: any) => {
                const late = o.requestedShipmentDate && new Date(o.requestedShipmentDate) < new Date() && ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER', 'PARTIALLY_SHIPPED'].includes(o.status);
                return (
                  <tr key={o.id} className="click" onClick={() => nav(`/orders/${encodeURIComponent(o.id)}`)}>
                    <td><strong>{o.orderNumber}</strong><div className="small muted mono">{o.id}</div>{o.lastError && <div className="small bad">{o.lastError.slice(0, 80)}</div>}</td>
                    <td><Status value={o.status} /></td><td className="small">{dt(o.orderDate)}</td>
                    <td className={`small ${late ? 'bad' : ''}`}>{dt(o.requestedShipmentDate)}{late && ' · late'}</td>
                    <td className="small">{dt(o.requestedDeliveryDate)}</td><td>{o.customer ?? <span className="muted">—</span>}</td>
                    <td className="num">{o.units}</td><td className="num">{money(o.total)}</td><td className="small">{o.shopifyOrderName ?? <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

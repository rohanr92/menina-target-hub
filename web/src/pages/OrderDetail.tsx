import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dt, money } from '../lib/format';
import { Btn, Card, ErrorBox, Field, Json, Loading, PageHead, Status, useAction, useLoad } from '../components/ui';

const REASONS = ['ITEM_NOT_AVAILABLE', 'COULD_NOT_SHIP', 'SHIPPING_ADDRESS_UNDELIVERABLE', 'BUYER_CANCELED', 'GENERAL_ADJUSTMENT', 'ALTERNATE_ITEM_PROVIDED', 'MERCHANDISE_NOT_RECEIVED', 'CUSTOMER_RETURNED_ITEM', 'CUSTOMER_EXCHANGE', 'OTHER'];
const qtyIn = (l: any, s: string) => (l.order_line_statuses ?? []).filter((x: any) => x.status === s).reduce((a: number, x: any) => a + Number(x.quantity || 0), 0);
const openQty = (l: any) => qtyIn(l, 'ACKNOWLEDGED_BY_SELLER') + qtyIn(l, 'PENDING');
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
/** A tracking number in the right format for the carrier (for stage tests; stage does not check real shipments). */
function testTracking(method: string, carrier = '') {
  const c = `${carrier} ${method}`.toUpperCase();
  if (c.includes('USPS')) return `9400${digits(18)}`;
  if (c.includes('UPS')) return `1Z${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')}03${digits(8)}`;
  if (c.includes('FEDEX') || c.includes('FDE')) return digits(12);
  return digits(12);
}

export default function OrderDetail() {
  const { id } = useParams();
  const d = useLoad(() => get(`/api/orders/${encodeURIComponent(id!)}`), [id]);
  const { busy, run } = useAction();
  const [ship, setShip] = useState<Record<string, number>>({});
  const [cancel, setCancel] = useState<Record<string, number>>({});
  const [method, setMethod] = useState('');
  const [tracking, setTracking] = useState('');
  const [shippedDate, setShippedDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [reason, setReason] = useState('ITEM_NOT_AVAILABLE');
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => { if (d.data && !method) setMethod(d.data.shippingMethods?.[0]?.shippingMethod ?? ''); }, [d.data, method]);
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (d.error) return <div className="page"><ErrorBox error={d.error} /></div>;
  const o = d.data;
  const lines: any[] = o.raw?.order_lines ?? [];
  const sa = o.address?.shipping_address;
  const reload = d.reload;
  const enc = encodeURIComponent(o.id);
  const fulfillments: any[] = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const anyOpen = lines.some((l) => openQty(l) > 0);
  const shipLines = () => Object.entries(ship).filter(([, q]) => q > 0).map(([n, q]) => ({ order_line_number: n, quantity: q, tracking_number: tracking, shipping_method: method, shipped_date: new Date(shippedDate).toISOString() }));

  return (
    <div className="page">
      <PageHead title={`Order ${o.orderNumber ?? o.id}`} sub={<><Link to="/orders">Orders</Link> · id <code>{o.id}</code> · <Status value={o.status} /></>}>
        <Btn busy={busy === 'ref'} onClick={() => run('ref', () => post(`/api/orders/${enc}/refresh`), 'Refreshed').then(reload)}>Refresh</Btn>
        {o.status === 'RELEASED_FOR_SHIPMENT' && <Btn kind="primary" busy={busy === 'ack'} onClick={() => run('ack', () => post(`/api/orders/${enc}/acknowledge`), 'Acknowledged').then(reload)}>Acknowledge</Btn>}
        {!o.shopifyOrderId && anyOpen && <Btn busy={busy === 'shop'} onClick={() => run('shop', () => post(`/api/orders/${enc}/push-shopify`), (r: any) => `Created ${r.name ?? ''} in Shopify`).then(reload)}>Create in Shopify</Btn>}
      </PageHead>

      <div className="grid3" style={{ marginBottom: 16 }}>
        <Card title="Dates">
          <div className="kv">
            <div>Ordered</div><div>{dt(o.orderDate)}</div>
            <div>Ship by</div><div>{dt(o.requestedShipmentDate)}</div>
            <div>Deliver by</div><div>{dt(o.requestedDeliveryDate)}</div>
            <div>Acknowledged</div><div>{dt(o.acknowledgedAt)}</div>
            <div>Level of service</div><div>{o.raw?.level_of_service ?? '—'}</div>
          </div>
        </Card>
        <Card title="Ship to" actions={!sa && <Btn size="sm" onClick={() => run('addr', () => post(`/api/orders/${enc}/address`), 'Address loaded').then(reload)}>Load address</Btn>}>
          {sa ? <div className="small">{sa.first_name} {sa.last_name}<br />{sa.address1}{sa.address2 ? <>, {sa.address2}</> : ''}<br />{sa.city}, {sa.state} {sa.postal_code} {sa.country_code}<br /><span className="muted">{sa.phone_numbers?.map((p: any) => p.number).join(', ')}</span></div> : <span className="muted small">Target only returns the address on request.</span>}
        </Card>
        <Card title="Shopify">
          <div className="kv">
            <div>Order</div><div>{o.shopifyOrderName ?? <span className="muted">not created</span>}</div>
            {o.shopifyPushError && <><div>Error</div><div className="bad small">{o.shopifyPushError}</div></>}
            {o.lastError && <><div>Last error</div><div className="bad small">{o.lastError}</div></>}
          </div>
        </Card>
      </div>

      <Card title="Lines" pad={false}>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>SKU / TCIN</th><th className="num">Qty</th><th className="num">Unit</th><th>Line status</th><th className="num">Open</th><th style={{ width: 110 }}>Ship qty</th><th style={{ width: 110 }}>Cancel qty</th></tr></thead>
          <tbody>
            {lines.map((l) => {
              const open = openQty(l);
              const item = o.items?.find((x: any) => x.sku === l.external_id);
              return (
                <tr key={l.order_line_number}>
                  <td>{l.order_line_number}</td>
                  <td><code>{l.external_id}</code> · TCIN <code>{l.tcin}</code>{item && <div className="small"><Link to={`/products/${item.productId}`}>open product</Link></div>}{!item && <div className="small warn">SKU not in hub</div>}</td>
                  <td className="num">{l.quantity}</td><td className="num">{money(l.unit_price)}</td>
                  <td className="small">{(l.order_line_statuses ?? []).map((s: any) => `${s.status.replace(/_/g, ' ').toLowerCase()} ${s.quantity}`).join(' · ')}{l.cancellation_reason && <div className="muted">{l.cancellation_reason}</div>}</td>
                  <td className="num">{open}</td>
                  <td><input type="number" min={0} max={open} disabled={!open} value={ship[l.order_line_number] ?? ''} placeholder="0" onChange={(e) => setShip({ ...ship, [l.order_line_number]: Math.min(open, Number(e.target.value)) })} /></td>
                  <td><input type="number" min={0} max={open} disabled={!open} value={cancel[l.order_line_number] ?? ''} placeholder="0" onChange={(e) => setCancel({ ...cancel, [l.order_line_number]: Math.min(open, Number(e.target.value)) })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        {anyOpen && (
          <div className="card-b" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <button className="btn sm" onClick={() => setShip(Object.fromEntries(lines.map((l) => [l.order_line_number, openQty(l)])))}>Ship everything open</button>
              <button className="btn sm" onClick={() => setCancel(Object.fromEntries(lines.map((l) => [l.order_line_number, openQty(l)])))}>Cancel everything open</button>
              <button className="btn ghost sm" onClick={() => { setShip({}); setCancel({}); }}>Clear</button>
            </div>
            <div className="grid2">
              <div className="stack">
                <h3>Ship</h3>
                <div className="grid3" style={{ gap: 8 }}>
                  <Field label="Shipping method"><select value={method} onChange={(e) => setMethod(e.target.value)}>{o.shippingMethods.map((m: any) => <option key={m.id} value={m.shippingMethod}>{m.shippingMethod} ({m.scac})</option>)}</select></Field>
                  <Field label="Tracking number"><input value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
                  <Field label="Shipped at"><input type="datetime-local" value={shippedDate} onChange={(e) => setShippedDate(e.target.value)} /></Field>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Btn kind="primary" busy={busy === 'ship'} disabled={!Object.values(ship).some((x) => x > 0)} onClick={() => run('ship', () => post(`/api/orders/${enc}/ship`, {
                    lines: shipLines(),
                  }), 'Fulfillment sent to Target').then(() => { setShip({}); reload(); })}>Send shipment</Btn>
                  <Btn busy={busy === 'shipc'} disabled={!Object.values(ship).some((x) => x > 0)} onClick={() => confirm(`Ship the entered quantities, then cancel what is left on those lines (reason: ${reason})?`) && run('shipc', () => post(`/api/orders/${enc}/ship-cancel-rest`, {
                    lines: shipLines(), reason,
                  }), (r: any) => `Shipped and canceled the rest on ${r?.canceled?.length ?? 0} line(s)`).then(() => { setShip({}); reload(); })}>Ship &amp; cancel the rest</Btn>
                  <button className="btn ghost sm" onClick={() => setTracking(testTracking(method, o.shippingMethods.find((m: any) => m.shippingMethod === method)?.carrier))}>Test tracking number</button>
                </div>
                <span className="small muted">"Ship &amp; cancel the rest" ships the quantities above and cancels the unshipped units of those lines with the reason on the right (test plan 1.4, 2.4, 3.4). The tracking number must match the carrier.</span>
              </div>
              <div className="stack">
                <h3>Cancel</h3>
                <Field label="Reason"><select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
                <div><Btn kind="danger" busy={busy === 'cancel'} disabled={!Object.values(cancel).some((x) => x > 0)} onClick={() => confirm('Cancel the selected quantities on Target? This cannot be undone.') && run('cancel', () => post(`/api/orders/${enc}/cancel`, { reason, lines: Object.entries(cancel).filter(([, q]) => q > 0).map(([n, q]) => ({ order_line_number: n, quantity: q })) }), 'Cancellation sent').then(() => { setCancel({}); reload(); })}>Cancel quantities</Btn></div>
                <span className="small muted">Partial cancels send the full line breakdown (canceled + acknowledged + shipped), as Target requires.</span>
              </div>
            </div>
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title="Fulfillments sent">
          {fulfillments.length === 0 ? <span className="muted small">None yet.</span> : (
            <table><thead><tr><th>ID</th><th>Line</th><th className="num">Qty</th><th>Method</th><th>Tracking</th><th>Shipped</th></tr></thead>
              <tbody>{fulfillments.map((f) => <tr key={f.id}><td className="mono small">{f.id}</td><td>{f.order_line_number}</td><td className="num">{f.quantity}</td><td>{f.shipping_method}</td><td className="mono small">{f.tracking_number}</td><td className="small">{dt(f.shipped_date)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <div style={{ marginTop: 16 }}><button className="btn ghost sm" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide' : 'Show'} raw order JSON</button>{showRaw && <div style={{ marginTop: 8 }}><Json value={o.raw} /></div>}</div>
    </div>
  );
}

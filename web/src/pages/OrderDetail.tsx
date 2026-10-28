import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dt, money } from '../lib/format';
import { Btn, ErrorBox, Field, Json, Loading, Status, useAction, useLoad } from '../components/ui';

const REASONS = ['ITEM_NOT_AVAILABLE', 'COULD_NOT_SHIP', 'SHIPPING_ADDRESS_UNDELIVERABLE', 'BUYER_CANCELED', 'GENERAL_ADJUSTMENT', 'ALTERNATE_ITEM_PROVIDED', 'MERCHANDISE_NOT_RECEIVED', 'CUSTOMER_RETURNED_ITEM', 'CUSTOMER_EXCHANGE', 'OTHER'];
const qtyIn = (l: any, s: string) => (l.order_line_statuses ?? []).filter((x: any) => x.status === s).reduce((a: number, x: any) => a + Number(x.quantity || 0), 0);
const openQty = (l: any) => qtyIn(l, 'ACKNOWLEDGED_BY_SELLER') + qtyIn(l, 'PENDING');
const nice = (s?: string) => (s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
/** A tracking number in the right format for the carrier (for stage tests; stage does not check real shipments). */
function testTracking(method: string, carrier = '') {
  const c = `${carrier} ${method}`.toUpperCase();
  if (c.includes('USPS')) return `9400${digits(18)}`;
  if (c.includes('UPS')) return `1Z${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')}03${digits(8)}`;
  return digits(12);
}
const SUSPICIOUS_PRICE = 5000; // a unit price above this is almost certainly a data error (e.g. a TCIN typed as price)

export default function OrderDetail() {
  const { id } = useParams();
  const d = useLoad(() => get(`/api/orders/${encodeURIComponent(id!)}`), [id]);
  const { busy, run } = useAction();
  const [ship, setShip] = useState<Record<string, number>>({});
  const [cancel, setCancel] = useState<Record<string, number>>({});
  const [method, setMethod] = useState('');
  const [tracking, setTracking] = useState('');
  const [shippedDate, setShippedDate] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [reason, setReason] = useState('ITEM_NOT_AVAILABLE');
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => { if (d.data && !method) setMethod(d.data.shippingMethods?.[0]?.shippingMethod ?? ''); }, [d.data, method]);
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (d.error) return <div className="page"><ErrorBox error={d.error} /></div>;

  const o = d.data;
  const raw = o.raw ?? {};
  const lines: any[] = raw.order_lines ?? [];
  const sa = o.address?.shipping_address;
  const reload = d.reload;
  const enc = encodeURIComponent(o.id);
  const fulfillments: any[] = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const itemOf = (l: any) => o.items?.find((x: any) => x.sku === l.external_id);
  const lineByNo = (n: string) => lines.find((l) => String(l.order_line_number) === String(n));
  const anyOpen = lines.some((l) => openQty(l) > 0);
  const totals = {
    units: lines.reduce((a, l) => a + Number(l.quantity || 0), 0),
    open: lines.reduce((a, l) => a + openQty(l), 0),
    shipped: lines.reduce((a, l) => a + qtyIn(l, 'SHIPPED'), 0),
    canceled: lines.reduce((a, l) => a + qtyIn(l, 'CANCELED'), 0),
    items: lines.reduce((a, l) => a + Number(l.unit_price || 0) * Number(l.quantity || 0), 0),
    shipping: lines.reduce((a, l) => a + Number(l.total_shipping_price || 0) - Number(l.total_shipping_discount || 0), 0),
    discount: lines.reduce((a, l) => a + Number(l.total_item_discount || 0), 0),
  };
  const badPrice = lines.filter((l) => Number(l.unit_price) > SUSPICIOUS_PRICE);
  const late = o.requestedShipmentDate && new Date(o.requestedShipmentDate) < new Date() && anyOpen;
  const shipLines = () => Object.entries(ship).filter(([, q]) => q > 0).map(([n, q]) => ({ order_line_number: n, quantity: q, tracking_number: tracking, shipping_method: method, shipped_date: new Date(shippedDate).toISOString() }));
  const shipsSomething = Object.values(ship).some((x) => x > 0);
  const carrierOf = (m: string) => o.shippingMethods.find((x: any) => x.shippingMethod === m)?.carrier;

  // group fulfillments into shipments (same tracking number = one package)
  const shipments = Object.values(fulfillments.reduce((acc: Record<string, any>, f) => {
    const k = `${f.tracking_number}|${f.shipping_method}`;
    (acc[k] ??= { tracking: f.tracking_number, method: f.shipping_method, date: f.shipped_date, ids: [], rows: [] });
    acc[k].ids.push(f.id); acc[k].rows.push(f);
    return acc;
  }, {})) as any[];
  const canceledRows = lines.filter((l) => qtyIn(l, 'CANCELED') > 0);

  const timeline: { at?: string | null; text: React.ReactNode; tone?: string }[] = [
    { at: o.orderDate, text: 'Order placed on Target.com' },
    ...(raw.created ? [{ at: raw.created, text: 'Released to Menina Step' }] : []),
    ...(o.acknowledgedAt ? [{ at: o.acknowledgedAt, text: 'Acknowledged', tone: 'ok' }] : []),
    ...shipments.map((s) => ({ at: s.date, text: <>Shipped {s.rows.reduce((a: number, r: any) => a + Number(r.quantity), 0)} unit(s) via {s.method} · <span className="mono">{s.tracking}</span></>, tone: 'ok' })),
    ...canceledRows.map((l) => ({ at: null, text: <>Canceled {qtyIn(l, 'CANCELED')} × {l.external_id} ({nice(l.cancellation_reason)})</>, tone: 'bad' })),
  ].sort((a, b) => (a.at ? new Date(a.at).getTime() : Infinity) - (b.at ? new Date(b.at).getTime() : Infinity));

  const ItemRow = ({ l, qty, right }: { l: any; qty: number; right?: React.ReactNode }) => {
    const it = itemOf(l);
    const img = it?.imageUrl ?? it?.productImages?.[0];
    const opts = it?.options ? Object.values(it.options).join(' / ') : '';
    const bad = Number(l.unit_price) > SUSPICIOUS_PRICE;
    return (
      <div className="od-item">
        <div className="od-thumb">{img ? <img src={img} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /> : <span>{(l.external_id ?? '?').slice(0, 2)}</span>}{qty > 0 && <b>{qty}</b>}</div>
        <div className="od-info">
          <div className="od-title">{it ? <Link to={`/products/${it.productId}`}>{it.productTitle ?? l.external_id}</Link> : l.external_id}</div>
          {opts && <div className="muted small">{opts}</div>}
          <div className="muted small mono">SKU {l.external_id} · TCIN {l.tcin} · line {l.order_line_number}</div>
          {!it && <div className="small warn">SKU not found in the hub</div>}
        </div>
        <div className={`od-price ${bad ? 'bad' : ''}`}>{money(l.unit_price)} × {qty}{bad && <div className="small">price looks wrong</div>}</div>
        {right && <div className="od-right">{right}</div>}
      </div>
    );
  };

  return (
    <div className="page od">
      <div className="od-head">
        <div>
          <div className="small"><Link to="/orders">← Orders</Link></div>
          <h1>Order #{o.orderNumber ?? o.id}</h1>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Status value={o.status} />
            {totals.open > 0 && <span className="pill warn">{totals.open} to ship</span>}
            {totals.shipped > 0 && <span className="pill ok">{totals.shipped} shipped</span>}
            {totals.canceled > 0 && <span className="pill bad">{totals.canceled} canceled</span>}
            {late && <span className="pill bad">ship date passed</span>}
            <span className="muted small">Placed {dt(o.orderDate)} · <span className="mono">{o.id}</span></span>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {o.status === 'RELEASED_FOR_SHIPMENT' && <Btn kind="primary" busy={busy === 'ack'} onClick={() => run('ack', () => post(`/api/orders/${enc}/acknowledge`), 'Acknowledged').then(reload)}>Acknowledge</Btn>}
          {!o.shopifyOrderId && anyOpen && <Btn busy={busy === 'shop'} onClick={() => run('shop', () => post(`/api/orders/${enc}/push-shopify`), (r: any) => `Created ${r.name ?? ''} in Shopify`).then(reload)}>Create in Shopify</Btn>}
          <Btn busy={busy === 'ref'} onClick={() => run('ref', () => post(`/api/orders/${enc}/refresh`), 'Refreshed from Target').then(reload)}>Refresh</Btn>
        </div>
      </div>

      {badPrice.length > 0 && <div className="od-alert bad">Target sent an unusual unit price on {badPrice.map((l) => `${l.external_id} (${money(l.unit_price)})`).join(', ')}. This looks like a data error in the order; the hub shows Target's numbers as they are.</div>}
      {o.lastError && <div className="od-alert bad">Last error: {o.lastError}</div>}

      <div className="od-grid">
        <div className="od-main">
          {anyOpen && (
            <section className="od-card">
              <header className="warn"><span className="dot" />To ship <span className="muted">· {totals.open} unit(s)</span>
                <span className="od-hint">
                  <button className="btn sm ghost" onClick={() => setShip(Object.fromEntries(lines.map((l) => [l.order_line_number, openQty(l)])))}>Ship all</button>
                  <button className="btn sm ghost" onClick={() => setCancel(Object.fromEntries(lines.map((l) => [l.order_line_number, openQty(l)])))}>Cancel all</button>
                  <button className="btn sm ghost" onClick={() => { setShip({}); setCancel({}); }}>Clear</button>
                </span>
              </header>
              {lines.filter((l) => openQty(l) > 0).map((l) => {
                const open = openQty(l);
                return <ItemRow key={l.order_line_number} l={l} qty={open} right={
                  <div className="od-qty">
                    <label>Ship<input type="number" min={0} max={open} value={ship[l.order_line_number] ?? ''} placeholder="0" onChange={(e) => setShip({ ...ship, [l.order_line_number]: Math.max(0, Math.min(open, Number(e.target.value))) })} /></label>
                    <label>Cancel<input type="number" min={0} max={open} value={cancel[l.order_line_number] ?? ''} placeholder="0" onChange={(e) => setCancel({ ...cancel, [l.order_line_number]: Math.max(0, Math.min(open, Number(e.target.value))) })} /></label>
                  </div>} />;
              })}
              <div className="od-actions">
                <div className="od-act">
                  <div className="od-act-t">Ship</div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ width: 200 }}><Field label="Shipping method"><select value={method} onChange={(e) => setMethod(e.target.value)}>{o.shippingMethods.map((m: any) => <option key={m.id} value={m.shippingMethod}>{m.shippingMethod} ({m.scac})</option>)}</select></Field></div>
                    <div style={{ width: 230 }}><Field label="Tracking number"><input value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field></div>
                    <div style={{ width: 200 }}><Field label="Shipped at"><input type="datetime-local" value={shippedDate} onChange={(e) => setShippedDate(e.target.value)} /></Field></div>
                    <button className="btn sm ghost" style={{ marginBottom: 4 }} onClick={() => setTracking(testTracking(method, carrierOf(method)))}>Test tracking number</button>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    <Btn kind="primary" busy={busy === 'ship'} disabled={!shipsSomething} onClick={() => run('ship', () => post(`/api/orders/${enc}/ship`, { lines: shipLines() }), 'Shipment sent to Target').then(() => { setShip({}); reload(); })}>Send shipment</Btn>
                    <Btn busy={busy === 'shipc'} disabled={!shipsSomething} onClick={() => confirm(`Ship the entered quantities, then cancel what is left on those lines (reason: ${nice(reason)})?`) && run('shipc', () => post(`/api/orders/${enc}/ship-cancel-rest`, { lines: shipLines(), reason }), (r: any) => `Shipped and canceled the rest on ${r?.canceled?.length ?? 0} line(s)`).then(() => { setShip({}); reload(); })}>Ship &amp; cancel the rest</Btn>
                  </div>
                  <div className="small muted" style={{ marginTop: 6 }}>Enter the Ship quantities above. "Ship &amp; cancel the rest" also cancels the unshipped units of those lines with the reason below.</div>
                </div>
                <div className="od-act">
                  <div className="od-act-t">Cancel</div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ width: 260 }}><Field label="Reason"><select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r} value={r}>{nice(r)}</option>)}</select></Field></div>
                    <Btn kind="danger" busy={busy === 'cancel'} disabled={!Object.values(cancel).some((x) => x > 0)} onClick={() => confirm('Cancel the entered quantities on Target? This cannot be undone.') && run('cancel', () => post(`/api/orders/${enc}/cancel`, { reason, lines: Object.entries(cancel).filter(([, q]) => q > 0).map(([n, q]) => ({ order_line_number: n, quantity: q })) }), 'Cancellation sent to Target').then(() => { setCancel({}); reload(); })}>Cancel quantities</Btn>
                  </div>
                </div>
              </div>
            </section>
          )}

          {shipments.map((s, i) => (
            <section className="od-card" key={i}>
              <header className="ok"><span className="dot" />Shipped <span className="muted">· {s.method} · <span className="mono">{s.tracking}</span> · {dt(s.date)}</span></header>
              {s.rows.map((f: any) => { const l = lineByNo(f.order_line_number); return l ? <ItemRow key={f.id} l={l} qty={Number(f.quantity)} /> : null; })}
              <div className="od-foot muted small">Shipment id{s.ids.length > 1 ? 's' : ''}: <span className="mono">{s.ids.join(', ')}</span></div>
            </section>
          ))}

          {canceledRows.length > 0 && (
            <section className="od-card">
              <header className="bad"><span className="dot" />Canceled <span className="muted">· {totals.canceled} unit(s)</span></header>
              {canceledRows.map((l) => <ItemRow key={l.order_line_number} l={l} qty={qtyIn(l, 'CANCELED')} right={<span className="pill bad">{nice(l.cancellation_reason) || 'Canceled'}</span>} />)}
            </section>
          )}

          <section className="od-card">
            <header><span className="dot" />Timeline</header>
            <ul className="od-timeline">
              {timeline.map((t, i) => <li key={i} className={t.tone ?? ''}><span className="od-tdot" /><div>{t.text}</div><div className="muted small">{t.at ? dt(t.at) : ''}</div></li>)}
            </ul>
          </section>
          <div><button className="btn ghost sm" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide' : 'Show'} raw order JSON</button>{showRaw && <div style={{ marginTop: 8 }}><Json value={raw} /></div>}</div>
        </div>

        <aside className="od-side">
          <section className="od-card">
            <header>Summary</header>
            <div className="od-kv">
              <span>Items ({totals.units})</span><span>{money(totals.items)}</span>
              {totals.discount > 0 && <><span>Item discount</span><span>−{money(totals.discount)}</span></>}
              <span>Shipping (guest paid)</span><span>{money(totals.shipping)}</span>
              <b>Total</b><b>{money(totals.items - totals.discount + totals.shipping)}</b>
            </div>
            <div className="od-units">
              <div><b>{totals.open}</b><span>to ship</span></div>
              <div className="ok"><b>{totals.shipped}</b><span>shipped</span></div>
              <div className="bad"><b>{totals.canceled}</b><span>canceled</span></div>
            </div>
          </section>
          <section className="od-card">
            <header>Customer {!sa && <span className="od-hint"><button className="btn sm ghost" onClick={() => run('addr', () => post(`/api/orders/${enc}/address`), 'Address loaded').then(reload)}>Load address</button></span>}</header>
            {sa ? <div className="od-pad">
              <div><b>{sa.first_name} {sa.last_name}</b></div>
              <div className="small">{sa.address1}{sa.address2 ? <>, {sa.address2}</> : ''}<br />{sa.city}, {sa.state} {sa.postal_code} {sa.country_code}</div>
              {sa.phone_numbers?.length > 0 && <div className="muted small">{sa.phone_numbers.map((p: any) => p.number).join(', ')}</div>}
            </div> : <div className="od-pad muted small">Target only returns the address on request.</div>}
          </section>
          <section className="od-card">
            <header>Dates</header>
            <div className="od-kv">
              <span>Ordered</span><span>{dt(o.orderDate)}</span>
              <span>Acknowledged</span><span>{dt(o.acknowledgedAt)}</span>
              <span>Ship by</span><span className={late ? 'bad' : ''}>{dt(o.requestedShipmentDate)}</span>
              <span>Deliver by</span><span>{dt(o.requestedDeliveryDate)}</span>
            </div>
          </section>
          <section className="od-card">
            <header>Target</header>
            <div className="od-kv">
              <span>Order id</span><span className="mono small">{o.id}</span>
              <span>Warehouse (DC)</span><span>{raw.distribution_center_id ?? '—'}</span>
              <span>Ship node</span><span>{raw.ship_node_id ?? '—'}</span>
              <span>Level of service</span><span>{raw.level_of_service ?? '—'}</span>
            </div>
          </section>
          <section className="od-card">
            <header>Shopify</header>
            <div className="od-kv">
              <span>Order</span><span>{o.shopifyOrderName ?? <span className="muted">not created</span>}</span>
              {o.shopifyPushError && <><span>Error</span><span className="bad small">{o.shopifyPushError}</span></>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { Btn, Card, ErrorBox, Loading, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function ListingErrors() {
  const [severity, setSeverity] = useState('');
  const [listing, setListing] = useState('');
  const r = useLoad(() => get(`/api/listing-errors?severity=${severity}&listing_status=${listing}`), [severity, listing]);
  const rows: any[] = r.data ?? [];
  const { busy, run } = useAction();
  const nav = useNavigate();
  return (
    <div className="page">
      <PageHead title="Listing errors" sub="Items with validation or listing errors on Target (product_catalog_errors). CRITICAL errors block the item from listing; fix the data and send an update.">
        <Btn kind="primary" busy={busy === 'rep'} onClick={() => run('rep', () => post('/api/reports/quick', { preset: 'item_errors' }), 'Item errors report requested').then(() => nav('/reports'))}>Pull item errors report</Btn>
        <Btn kind="ghost" onClick={() => setListing('REJECTED')}>Show rejected only</Btn>
      </PageHead>
      <div className="row" style={{ marginBottom: 12 }}>
        <select style={{ width: 180 }} value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">Any severity</option><option>CRITICAL</option><option>NON_CRITICAL</option><option>WARNING</option></select>
        <select style={{ width: 180 }} value={listing} onChange={(e) => setListing(e.target.value)}><option value="">Any listing status</option><option>REJECTED</option><option>PENDING</option><option>APPROVED</option></select>
      </div>
      {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <Card pad={false}>
          <div className="table-wrap"><table>
            <thead><tr><th>SKU</th><th>TCIN</th><th>Status</th><th>Errors</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No listing errors. Nice.</td></tr>}
              {rows.map((x) => {
                const st = (x.product_statuses ?? []).find((s: any) => s.latest) ?? x.product_statuses?.[0] ?? {};
                return (
                  <tr key={x.id}>
                    <td><code>{x.external_id}</code></td><td><code>{x.tcin}</code></td>
                    <td><div className="row" style={{ gap: 4 }}><Status value={st.listing_status} /><Status value={st.validation_status} /></div></td>
                    <td className="small">{(st.errors ?? []).map((e: any, i: number) => <div key={i}><span className={e.error_severity === 'CRITICAL' ? 'bad' : 'warn'}>{e.error_severity}</span> · {e.reason}{e.field_name && <> · <code>{e.field_name}</code></>}{e.partner_action && <div className="muted">Action: {e.partner_action}</div>}</div>)}</td>
                    <td>{x.productId && <Link className="btn sm" to={`/products/${x.productId}`}>Fix</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}

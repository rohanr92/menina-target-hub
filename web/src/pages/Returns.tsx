import { useState } from 'react';
import { get } from '../lib/api';
import { dt } from '../lib/format';
import { Card, ErrorBox, Loading, PageHead, Tabs, useLoad } from '../components/ui';

export default function Returns() {
  const [tab, setTab] = useState<'returns' | 'disputes'>('returns');
  const r = useLoad(() => get(tab === 'returns' ? '/api/returns' : '/api/returns/disputes'), [tab]);
  const rows: any[] = Array.isArray(r.data) ? r.data : [];
  return (
    <div className="page">
      <PageHead title="Returns" sub="Guest returns and return disputes, read live from Target. Use the RETURN_ORDERS_EXTERNAL report for bulk history." />
      <Tabs value={tab} onChange={setTab} items={[['returns', 'Product returns'], ['disputes', 'Return disputes']]} />
      {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <Card pad={false}>
          <div className="table-wrap"><table>
            {tab === 'returns' ? <>
              <thead><tr><th>Return #</th><th>Order</th><th>SKU</th><th>TCIN</th><th className="num">Qty</th><th>Reason</th><th>Return date</th><th>Disposition</th><th>Tracking</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="empty">No returns.</td></tr>}
                {rows.map((x) => <tr key={x.id}><td className="mono small">{x.reference_id ?? x.id}</td><td>{x.order_number}</td><td><code>{x.external_id}</code></td><td><code>{x.tcin}</code></td><td className="num">{x.quantity}</td><td>{x.return_reason}</td><td className="small">{dt(x.return_date)}</td><td className="small">{[x.financial_disposition, x.physical_disposition].filter(Boolean).join(' / ') || '—'}</td><td className="small mono">{x.tracking_data?.map((t: any) => t.tracking_number).filter(Boolean).join(', ') || '—'}</td></tr>)}
              </tbody>
            </> : <>
              <thead><tr><th>Case</th><th>Return order</th><th>Order</th><th>Reason</th><th>Judgement</th><th>Final response</th><th>Updated</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="empty">No disputes.</td></tr>}
                {rows.map((x) => <tr key={x.id}><td className="mono small">{x.case_id}</td><td>{x.return_order_number}</td><td>{x.order_id}</td><td>{x.dispute_reason}</td><td>{x.judgement}</td><td>{x.final_response}</td><td className="small">{dt(x.last_modified)}</td></tr>)}
              </tbody>
            </>}
          </table></div>
        </Card>
      )}
    </div>
  );
}

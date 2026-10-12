import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { ago, dt } from '../lib/format';
import { Btn, Card, Copy, Field, Loading, Modal, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function Reports() {
  const r = useLoad(() => get('/api/reports'));
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const { busy, run } = useAction();
  const [f, setF] = useState<any>({ type: 'ITEM_ERRORS', format: 'JSON', start_date: '', end_date: '', is_published: '', item_type_id: '' });
  const [preview, setPreview] = useState<any>(null);
  const reports = r.data?.reports ?? [];
  const open = reports.some((x: any) => ['PENDING', 'PROCESSING'].includes(x.status));
  useEffect(() => {
    if (!open) return;
    const t = setInterval(async () => {
      for (const x of reports.filter((y: any) => ['PENDING', 'PROCESSING'].includes(y.status)).slice(0, 5)) await post(`/api/reports/${x.id}/refresh`).catch(() => {});
      r.reload();
    }, 15000);
    return () => clearInterval(t);
  }, [open, reports.length]);
  const create = () => {
    const body: any = { type: f.type, format: f.format };
    if (f.start_date) body.start_date = new Date(f.start_date).toISOString();
    if (f.end_date) body.end_date = new Date(f.end_date).toISOString();
    const params: any = {};
    if (f.type === 'INVENTORY' && f.is_published !== '') params.is_published = f.is_published === 'true';
    if (f.type === 'BULK_PRODUCT_DATA_TEMPLATE' && f.item_type_id) params.item_type_id = f.item_type_id;
    if (Object.keys(params).length) body.parameters = params;
    return run('create', () => post('/api/reports', body), 'Report requested').then(r.reload);
  };
  return (
    <div className="page">
      <PageHead title="Reports" sub="Test plan › Reporting. Request any report, the hub polls until it completes, then download it. Stage downloads add the tgtrt header automatically.">
        <Btn busy={busy === 'sync'} onClick={() => run('sync', () => post('/api/reports/sync'), (x: any) => `${x.imported} reports loaded from Target`).then(r.reload)}>Load existing from Target</Btn>
      </PageHead>
      <Card title="New report request">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 240 }}><Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{(r.data?.types ?? []).map((t: string) => <option key={t}>{t}</option>)}</select></Field></div>
          <div style={{ width: 110 }}><Field label="Format"><select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option>JSON</option><option>CSV</option><option>EXCEL</option></select></Field></div>
          {['ORDERS', 'RETURN_ORDERS_EXTERNAL', 'PAYOUT_RECONCILIATION', 'SALES_METRICS', 'ORDER_DEFECTS', 'ORDERS_PAST_SLA'].includes(f.type) && <>
            <div style={{ width: 170 }}><Field label="Start"><input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field></div>
            <div style={{ width: 170 }}><Field label="End"><input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field></div>
          </>}
          {f.type === 'INVENTORY' && <div style={{ width: 200 }}><Field label="Items"><select value={f.is_published} onChange={(e) => setF({ ...f, is_published: e.target.value })}><option value="">Published + unpublished</option><option value="true">Published only</option><option value="false">Unpublished only</option></select></Field></div>}
          {f.type === 'BULK_PRODUCT_DATA_TEMPLATE' && <div style={{ width: 220 }}><Field label="Item type"><select value={f.item_type_id} onChange={(e) => setF({ ...f, item_type_id: e.target.value })}><option value="">—</option>{types.data?.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>}
          <Btn kind="primary" busy={busy === 'create'} onClick={create}>Request</Btn>
        </div>
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card pad={false}>
          {r.loading && !r.data ? <Loading /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Type</th><th>ID</th><th>Status</th><th>Format</th><th>Range / params</th><th>Requested</th><th>Download URL</th><th /></tr></thead>
              <tbody>
                {reports.length === 0 && <tr><td colSpan={8} className="empty">No reports yet.</td></tr>}
                {reports.map((x: any) => (
                  <tr key={x.id}>
                    <td><strong>{x.type}</strong></td><td className="mono small">{x.id}</td><td><Status value={x.status} /></td><td>{x.format}</td>
                    <td className="small muted">{x.params?.start_date ? `${dt(x.params.start_date)} – ${dt(x.params.end_date)}` : ''}{x.params?.parameters ? JSON.stringify(x.params.parameters) : ''}</td>
                    <td className="small muted">{ago(x.createdAt)}</td>
                    <td className="small">{x.downloadUrl ? <div className="row" style={{ gap: 4 }}><span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{x.downloadUrl}</span><Copy text={x.downloadUrl} /></div> : '—'}</td>
                    <td><div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      {['PENDING', 'PROCESSING'].includes(x.status) && <><button className="btn sm" onClick={() => run('ref', () => post(`/api/reports/${x.id}/refresh`)).then(r.reload)}>Check</button><button className="btn ghost sm" onClick={() => run('cancel', () => post(`/api/reports/${x.id}/cancel`), 'Cancel requested').then(r.reload)}>Cancel</button></>}
                      {x.status === 'COMPLETE' && <>
                        {x.format !== 'EXCEL' && <button className="btn sm" onClick={() => run('prev', async () => setPreview({ type: x.type, ...(await get(`/api/reports/${x.id}/preview`)) }))}>Preview</button>}
                        <a className="btn sm" href={`/api/reports/${x.id}/download`}>Download</a>
                        {x.type === 'ALLOWED_ITEM_TYPES' && <button className="btn sm" onClick={() => run('imp', () => post(`/api/reports/${x.id}/import-item-types`), (y: any) => `${y.count} item types loaded`)}>Import types</button>}
                      </>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
      {preview && (
        <Modal title={`${preview.type} · ${preview.total} rows`} wide onClose={() => setPreview(null)}>
          {preview.rows.length === 0 ? <div className="muted">Empty report.</div> : (
            <div className="table-wrap" style={{ maxHeight: '70vh' }}><table>
              <thead><tr>{Object.keys(preview.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
              <tbody>{preview.rows.map((row: any, i: number) => <tr key={i}>{Object.keys(preview.rows[0]).map((k) => <td key={k} className="small">{typeof row[k] === 'object' ? JSON.stringify(row[k]) : String(row[k] ?? '')}</td>)}</tr>)}</tbody>
            </table></div>
          )}
        </Modal>
      )}
    </div>
  );
}

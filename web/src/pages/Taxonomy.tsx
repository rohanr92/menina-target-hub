import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function Taxonomy() {
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const setup = useLoad(() => get('/api/taxonomy/setup'));
  const reports = useLoad(() => get('/api/reports'));
  const { busy, run } = useAction();
  const nav = useNavigate();
  const [manual, setManual] = useState({ id: '', name: '' });
  const allowed = (reports.data?.reports ?? []).filter((r: any) => r.type === 'ALLOWED_ITEM_TYPES');
  const latest = allowed[0];

  const request = () => run('req', () => post('/api/reports', { type: 'ALLOWED_ITEM_TYPES', format: 'EXCEL' }), 'Report requested. Refresh in a minute.').then(reports.reload);
  const refresh = () => run('ref', () => post(`/api/reports/${latest.id}/refresh`)).then(reports.reload);
  const importTypes = () => run('imp', () => post(`/api/reports/${latest.id}/import-item-types`), (r: any) => `${r.count} item types loaded`).then(types.reload);
  const upload = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    await run('up', () => api('/api/taxonomy/item-types/upload', { form: fd }), (r: any) => `${r.count} item types loaded`);
    types.reload();
  };

  return (
    <div className="page">
      <PageHead title="Taxonomy & mapping" sub="Test plan › Data Collection. Load the item types you are allowed to sell, pull each type’s attributes and value lists, then map your Shopify data onto them." />
      <div className="grid3" style={{ marginBottom: 16 }}>
        <Card title="1 · Allowed item types">
          <div className="stack small">
            <div className="row">
              <Btn kind="primary" size="sm" busy={busy === 'req'} onClick={request}>Request report</Btn>
              {latest && <Btn size="sm" busy={busy === 'ref'} onClick={refresh}>Check status</Btn>}
              {latest?.status === 'COMPLETE' && <Btn size="sm" busy={busy === 'imp'} onClick={importTypes}>Import types</Btn>}
            </div>
            {latest ? <div>Latest: <code>{latest.id}</code> <Status value={latest.status} /> <span className="muted">{ago(latest.createdAt)}</span></div> : <div className="muted">No report requested yet.</div>}
            <div className="muted">Or upload the report file (JSON / CSV / Excel) downloaded from the portal or Insomnia:</div>
            <input type="file" accept=".json,.csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <details>
              <summary className="muted" style={{ cursor: 'pointer' }}>Add an item type by ID</summary>
              <div className="row" style={{ marginTop: 6 }}>
                <input placeholder="Item type ID" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} style={{ width: 120 }} />
                <input placeholder="Name (e.g. Shoes)" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} style={{ width: 160 }} />
                <Btn size="sm" onClick={() => run('man', () => post('/api/taxonomy/item-types', manual), 'Added').then(types.reload)}>Add</Btn>
              </div>
            </details>
          </div>
        </Card>
        <Card title="2 · Setup data" actions={<Btn size="sm" busy={busy === 'setup'} onClick={() => run('setup', () => post('/api/taxonomy/setup'), (r: any) => `${r.distributionCenters} DCs, ${r.shippingMethods} shipping methods`).then(setup.reload)}>Pull setup data</Btn>}>
          {setup.loading ? <Loading /> : (
            <div className="stack small">
              <div><strong>Distribution centers</strong> <span className="muted">(inventory is sent per DC)</span></div>
              {setup.data.distributionCenters.length === 0 && <div className="muted">None loaded</div>}
              {setup.data.distributionCenters.map((d: any) => <div key={d.id}><code>{d.id}</code> {d.name}</div>)}
              <div style={{ marginTop: 6 }}><strong>Shipping methods</strong> ({setup.data.shippingMethods.length})</div>
              <div className="muted" style={{ maxHeight: 120, overflow: 'auto' }}>{setup.data.shippingMethods.map((m: any) => `${m.shippingMethod} (${m.scac})`).join(' · ') || 'None loaded'}</div>
            </div>
          )}
        </Card>
        <Card title="3 · Attributes & mapping">
          <div className="small stack">
            <p style={{ margin: 0 }}>Open an item type to pull its attributes (SELLING, CORE, TAX, LOGISTICS) and value lists, then set how each attribute is filled from Shopify.</p>
            <p className="muted" style={{ margin: 0 }}>Value lists can take many API calls; they run in the background, throttled.</p>
          </div>
        </Card>
      </div>
      <Card title="Item types" pad={false}>
        {types.loading && !types.data ? <Loading /> : (
          <table>
            <thead><tr><th>Item type</th><th>ID</th><th className="num">Attributes</th><th className="num">Required</th><th className="num">Products</th><th>Attributes pulled</th><th>Values pulled</th></tr></thead>
            <tbody>
              {types.data.length === 0 && <tr><td colSpan={7} className="empty">No item types yet. Request the ALLOWED_ITEM_TYPES report above.</td></tr>}
              {types.data.map((t: any) => (
                <tr key={t.id} className="click" onClick={() => nav(`/taxonomy/${t.id}`)}>
                  <td><strong>{t.name}</strong></td><td><code>{t.id}</code></td><td className="num">{t.attrs}</td><td className="num">{t.required}</td><td className="num">{t.products}</td>
                  <td className="muted">{t.attributesFetchedAt ? ago(t.attributesFetchedAt) : '—'}</td>
                  <td className="muted">{t.valuesProgress ? `running ${t.valuesProgress.done}/${t.valuesProgress.total}` : t.valuesFetchedAt ? ago(t.valuesFetchedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

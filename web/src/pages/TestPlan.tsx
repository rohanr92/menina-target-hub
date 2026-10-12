import { useMemo, useState } from 'react';
import { api, get, patch, post } from '../lib/api';
import { Btn, Card, Loading, PageHead, Status, Tabs, useAction, useLoad, useToast } from '../components/ui';

const SHEETS = ['Data Collection', 'Item Create-Update', 'Order Fulfillment', 'Reporting', 'Error Path'];
const HELP: Record<string, string> = {
  'Data Collection': 'Taxonomy & mapping page: request ALLOWED_ITEM_TYPES, pull attributes/values, pull setup data. Auto-fill reads the results.',
  'Item Create-Update': 'Products page: send SA / size / color / size & color items, then price, inventory, logistics, updates and unlist. Pick the product used for the scenario and click Auto-fill.',
  'Order Fulfillment': 'Target releases test orders; pull them on the Orders page, acknowledge, then ship / cancel exactly as the scenario says. Pick the order and Auto-fill.',
  'Reporting': 'Reports page: request the report types listed in each scenario (ITEM_ERRORS, ORDERS with a 30-day range then cancel, ALLOWED_ITEM_TYPES, INVENTORY published/unpublished).',
  'Error Path': 'Use the API console presets (invalid item type “nasal spray”, invalid brand “Artisinal Widgets”) and an order shipped with a broken tracking number. Paste the error you received.',
};

function Row({ s, ctx, onSaved }: { s: any; ctx: any; onSaved: (x: any) => void }) {
  const [ids, setIds] = useState(s.identifiers);
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const save = (body: any) => run('save', () => patch(`/api/testplan/${encodeURIComponent(s.id)}`, body)).then((x) => x && onSaved(x));
  const partner = s.owner === 'Partner';
  return (
    <tr style={partner ? undefined : { background: 'var(--bg-2)' }}>
      <td><strong>{s.scenario}</strong></td>
      <td className="small">{partner ? 'You' : <span className="muted">Target</span>}</td>
      <td className="small" style={{ maxWidth: 380 }}>
        {s.description}
        {s.notes && <div><button className="btn ghost sm" style={{ padding: 0, height: 'auto' }} onClick={() => setOpen(!open)}>{open ? 'Hide notes' : 'Notes'}</button>{open && <div className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.notes}</div>}</div>}
      </td>
      <td style={{ width: 320 }}>
        {partner ? (
          <div className="stack" style={{ gap: 4 }}>
            <textarea rows={Math.max(2, ids.split('\n').length)} value={ids} placeholder={s.hint} onChange={(e) => setIds(e.target.value)} onBlur={() => ids !== s.identifiers && save({ identifiers: ids })} style={{ fontSize: 12 }} />
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm" disabled={busy === 'auto'} onClick={() => run('auto', async () => {
                const r = await post(`/api/testplan/${encodeURIComponent(s.id)}/suggest`, ctx);
                if (!r.identifiers) throw new Error('Nothing to fill yet for this scenario (pick a product/order above, or do the step first)');
                setIds(r.identifiers); await save({ identifiers: r.identifiers });
              })}>Auto-fill</button>
              {s.hint && <span className="small muted" title={s.hint}>needs: {s.hint.split('\n').map((x: string) => x.replace(/:.*/, '')).filter(Boolean).join(', ')}</span>}
            </div>
          </div>
        ) : <span className="small muted">{s.identifiers || 'Validated by Target'}</span>}
      </td>
      <td style={{ width: 150 }}>
        {partner ? (
          <select value={s.status} onChange={(e) => save({ status: e.target.value })}>
            <option value="">Not started</option><option>In Progress</option><option>Complete</option>
          </select>
        ) : <Status value={s.status || null} />}
        {s.date && <div className="small muted">{new Date(s.date).toLocaleDateString()}</div>}
      </td>
    </tr>
  );
}

export default function TestPlan() {
  const list = useLoad(() => get('/api/testplan'));
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const products = useLoad(() => get('/api/products?state=on_target'));
  const orders = useLoad(() => get('/api/orders?status='));
  const [sheet, setSheet] = useState(SHEETS[0]);
  const [ctx, setCtx] = useState<any>({});
  const toast = useToast();
  const rows = (list.data ?? []) as any[];
  const bySheet = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const r of rows) (m[r.sheet] ??= []).push(r);
    return m;
  }, [rows]);
  const pct = (s: string) => { const p = (bySheet[s] ?? []).filter((r) => r.owner === 'Partner'); return p.length ? Math.round((p.filter((r) => r.status === 'Complete').length / p.length) * 100) : 0; };
  const onSaved = (x: any) => list.setData(rows.map((r) => (r.id === x.id ? x : r)));
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try { await api('/api/testplan/template', { form: fd }); toast('Template saved. Export will fill your answers into it.'); } catch (e: any) { toast(e.message, 'error'); }
  };
  if (list.loading && !list.data) return <div className="page"><Loading /></div>;
  const sections: [string, any[]][] = [];
  for (const r of bySheet[sheet] ?? []) {
    const last = sections[sections.length - 1];
    if (!last || last[0] !== r.section) sections.push([r.section, [r]]); else last[1].push(r);
  }
  return (
    <div className="page">
      <PageHead title="Test plan" sub="Target’s API Integration Test Plan, built in. Fill identifiers as you go (Auto-fill reads them from the hub), mark scenarios Complete, then export the filled workbook to send back to Target.">
        <label className="btn">Upload Target’s workbook<input type="file" accept=".xlsx" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
        <a className="btn primary" href="/api/testplan/export">Export filled workbook</a>
      </PageHead>
      <Tabs value={sheet} onChange={setSheet} items={SHEETS.map((s) => [s, `${s} · ${pct(s)}%`] as [string, string])} />
      <Card>
        <div className="stack small">
          <div>{HELP[sheet]}</div>
          <div className="row">
            {sheet === 'Data Collection' && <select style={{ width: 260 }} value={ctx.itemTypeId ?? ''} onChange={(e) => setCtx({ ...ctx, itemTypeId: e.target.value })}><option value="">Item type for 4.x – 6.x…</option>{types.data?.map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}</select>}
            {sheet === 'Item Create-Update' && <select style={{ width: 360 }} value={ctx.productId ?? ''} onChange={(e) => setCtx({ ...ctx, productId: e.target.value })}><option value="">Product used for the scenario…</option>{products.data?.items?.map((p: any) => <option key={p.id} value={p.id}>{p.title} · {p.theme}</option>)}</select>}
            {(sheet === 'Order Fulfillment' || sheet === 'Error Path') && <select style={{ width: 300 }} value={ctx.orderId ?? ''} onChange={(e) => setCtx({ ...ctx, orderId: e.target.value })}><option value="">Order used for the scenario…</option>{orders.data?.map((o: any) => <option key={o.id} value={o.id}>{o.orderNumber} · {o.status} · {o.units} units</option>)}</select>}
          </div>
        </div>
      </Card>
      {sections.map(([section, items]) => (
        <div key={section} style={{ marginTop: 16 }}>
          <h3>{section}</h3>
          <div className="card"><div className="table-wrap"><table>
            <thead><tr><th style={{ width: 50 }}>#</th><th style={{ width: 60 }}>Owner</th><th>Scenario</th><th>Identifiers</th><th>Status</th></tr></thead>
            <tbody>{items.map((s) => <Row key={s.id + s.updatedAt} s={s} ctx={ctx} onSaved={onSaved} />)}</tbody>
          </table></div></div>
        </div>
      ))}
      <div style={{ marginTop: 10 }}><Btn kind="ghost" size="sm" onClick={list.reload}>Reload</Btn></div>
    </div>
  );
}

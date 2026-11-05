import { useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { Btn, Card, ErrorBox, Field, Loading, Modal, PageHead, Tabs, useAction, useLoad } from '../components/ui';

type P = any;
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const local = (d?: string | null) => { if (!d) return ''; const x = new Date(d); const p = (n: number) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
const phase = (p: P) => {
  const now = Date.now();
  if (p.end_at && new Date(p.end_at).getTime() <= now) return 'past';
  if (p.start_at && new Date(p.start_at).getTime() <= now) return 'live';
  return 'upcoming';
};
const daysLeft = (d?: string | null) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 864e5) : null);
const pill = (bg: string, fg: string, text: string) => <span style={{ padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;

function PromoModal({ promo, onClose, onSaved }: { promo: P | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    name: promo?.name ?? '', category: promo?.category ?? '', start_at: local(promo?.start_at), end_at: local(promo?.end_at), deadline_at: local(promo?.deadline_at),
    status: promo?.status ?? 'planned', discount_type: promo?.discount_type ?? 'percent', discount_value: promo?.discount_value ?? '', codes: (promo?.skus ?? []).join('\n'), notes: promo?.notes ?? '',
  });
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const { busy, run } = useAction();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const save = () => run('save', async () => {
    const body = { ...f, start_at: iso(f.start_at), end_at: iso(f.end_at), deadline_at: iso(f.deadline_at), discount_type: f.discount_value === '' ? null : f.discount_type };
    const r = promo ? await put(`/api/promotions/${promo.id}`, body) : await post('/api/promotions', body);
    onSaved(); onClose();
    return r;
  }, (r: any) => `Saved · ${r.skus} SKU(s)${r.notFound?.length ? ` · not found: ${r.notFound.slice(0, 5).join(', ')}` : ''}`);
  const search = async () => { const r = await get(`/api/products?q=${encodeURIComponent(q)}&pageSize=10`); setFound(r.items ?? []); };
  const addProduct = async (id: string) => {
    const r = await get(`/api/products/${id}`);
    const skus = (r.variants ?? []).filter((v: any) => v.targetProductId).map((v: any) => v.sku).filter(Boolean);
    set('codes', [...new Set([...String(f.codes).split(/\s+/).filter(Boolean), ...skus])].join('\n'));
  };
  const n = String(f.codes).split(/[\s,;]+/).filter(Boolean).length;
  return (
    <Modal wide title={promo ? `Edit · ${promo.name}` : 'Add a promotion'} onClose={onClose}>
      <div className="grid2">
        <div className="stack">
          <Field label="Promotion name"><input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Target Circle Week" /></Field>
          <Field label="Category"><input value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. Shoes, Women's, Sitewide" /></Field>
          <div className="row" style={{ gap: 10 }}>
            <Field label="Starts"><input type="datetime-local" value={f.start_at} onChange={(e) => set('start_at', e.target.value)} /></Field>
            <Field label="Ends"><input type="datetime-local" value={f.end_at} onChange={(e) => set('end_at', e.target.value)} /></Field>
          </div>
          <Field label="Opt-in deadline" hint="You get an alert 3 days before while it is still “Planned”."><input type="datetime-local" value={f.deadline_at} onChange={(e) => set('deadline_at', e.target.value)} /></Field>
          <Field label="Status">
            <select value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="planned">Planned · deciding / not joined yet</option>
              <option value="joined">Joined · joined in the Partner Portal</option>
              <option value="skipped">Skipped · not taking part</option>
            </select>
          </Field>
          <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
            <Field label="Promo price on Target">
              <select value={f.discount_type} onChange={(e) => set('discount_type', e.target.value)}>
                <option value="percent">% off the current price</option>
                <option value="fixed">Fixed promo price ($)</option>
              </select>
            </Field>
            <Field label={f.discount_type === 'percent' ? 'Percent off' : 'Price'}><input type="number" step="0.01" value={f.discount_value} onChange={(e) => set('discount_value', e.target.value)} placeholder={f.discount_type === 'percent' ? '20' : '89.99'} /></Field>
          </div>
          <div className="small muted">Leave the price empty if Target applies the discount itself. When it is set and the status is <b>Joined</b>, the hub sends the sale price to these SKUs at the start and puts the normal price back at the end (list price stays the same, so it shows as a sale).</div>
          <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
        <div className="stack" style={{ alignContent: 'start' }}>
          <Field label={`SKUs in this promotion (${n})`} hint="SKUs, TCINs or barcodes, one per line (paste a column from Excel), or add whole products below.">
            <textarea rows={10} value={f.codes} onChange={(e) => set('codes', e.target.value)} placeholder={'CLAR-BLA-W35\n1012951791\n810228938753'} />
          </Field>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input style={{ flex: 1 }} placeholder="Find a product to add all its sizes…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
            <Btn size="sm" onClick={search} disabled={!q}>Search</Btn>
          </div>
          {found.map((p) => (
            <div key={p.id} className="row between small" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <span>{p.title}</span><button className="btn sm" onClick={() => addProduct(p.id)}>+ Add sizes on Target</button>
            </div>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <Btn kind="primary" busy={busy === 'save'} disabled={!f.name} onClick={save}>Save</Btn>
        <Btn onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

export default function Marketplace() {
  const d = useLoad(() => get('/api/promotions'), []);
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'upcoming' | 'live' | 'past'>('upcoming');
  const [edit, setEdit] = useState<P | null | 'new'>(null);
  const [showRaw, setShowRaw] = useState<number | null>(null);
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (d.error) return <div className="page"><ErrorBox error={d.error} /></div>;
  const all: P[] = d.data.promotions ?? [];
  const by = (k: string) => all.filter((p) => phase(p) === k);
  const list = by(tab).sort((a, b) => (tab === 'past' ? -1 : 1) * (new Date(a.start_at ?? a.deadline_at ?? 0).getTime() - new Date(b.start_at ?? b.deadline_at ?? 0).getTime()));
  const deadlines = all.filter((p) => p.status === 'planned' && p.deadline_at && daysLeft(p.deadline_at)! >= 0).sort((a, b) => +new Date(a.deadline_at) - +new Date(b.deadline_at));
  const sync = d.data.lastTargetSync;
  const Tile = ({ k, label }: { k: 'upcoming' | 'live' | 'past'; label: string }) => (
    <button onClick={() => setTab(k)} className="kpi" style={{ textAlign: 'left', cursor: 'pointer', border: `1px solid ${tab === k ? '#6366f1' : 'var(--line)'}`, background: tab === k ? '#eef2ff' : undefined }}>
      <div className="l">{label}</div><div className="v">{by(k).length}</div>
    </button>
  );
  return (
    <div className="page">
      <PageHead title="Marketplace portal" sub="Target promotions: upcoming, live and past, with opt-in deadlines. Join in the Partner Portal; the hub sends the promo price on the dates you set.">
        <a className="btn" href={d.data.portalUrl} target="_blank" rel="noreferrer">Open Partner Portal ↗</a>
        <Btn busy={busy === 'sync'} title="Reads Target's PROMOTIONS report (also runs once a day)" onClick={() => run('sync', () => post('/api/promotions/sync-target'), (r: any) => `${r.fromTarget} promotion(s) from Target`).then(d.reload)}>↻ From Target</Btn>
        <Btn kind="primary" onClick={() => setEdit('new')}>+ Add promotion</Btn>
      </PageHead>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Tile k="upcoming" label="Upcoming" />
        <Tile k="live" label="Live now" />
        <Tile k="past" label="Past" />
        <div className="kpi"><div className="l">Deadlines (not joined yet)</div><div className="v" style={{ color: deadlines.some((p) => daysLeft(p.deadline_at)! <= 3) ? '#b91c1c' : undefined }}>{deadlines.length}</div><div className="s">{deadlines[0] ? `next: ${day(deadlines[0].deadline_at)}` : 'none'}</div></div>
      </div>

      {deadlines.length > 0 && (
        <Card title="Opt-in deadlines">
          {deadlines.slice(0, 5).map((p) => { const dl = daysLeft(p.deadline_at)!; return (
            <div key={p.id} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <span><b>{p.name}</b>{p.category ? <span className="muted"> · {p.category}</span> : null}</span>
              <span className="row" style={{ gap: 8 }}>{pill(dl <= 1 ? '#fee2e2' : dl <= 3 ? '#fef3c7' : '#f1f5f9', dl <= 1 ? '#b91c1c' : dl <= 3 ? '#92400e' : '#334155', dl <= 0 ? 'today' : `${dl} day(s) left`)}<span className="small muted">{fmt(p.deadline_at)}</span>
                <a className="btn sm" href={d.data.portalUrl} target="_blank" rel="noreferrer">Join ↗</a>
                <button className="btn sm" onClick={() => run('j' + p.id, () => put(`/api/promotions/${p.id}`, { ...p, codes: (p.skus ?? []).join('\n'), status: 'joined' }), () => 'Marked as joined').then(d.reload)}>Mark joined</button>
              </span>
            </div>
          ); })}
        </Card>
      )}

      <div className="row between" style={{ margin: '16px 0 10px' }}>
        <Tabs value={tab} onChange={setTab} items={[['upcoming', `Upcoming (${by('upcoming').length})`], ['live', `Live (${by('live').length})`], ['past', `Past (${by('past').length})`]]} />
        <span className="small muted">From Target: {sync ? `${sync.count} promotion(s), read ${fmt(sync.at)}` : 'not read yet'}</span>
      </div>
      <Card pad={false}>
        <div className="table-wrap"><table>
          <thead><tr><th>Promotion</th><th>Category</th><th>Dates</th><th>Opt-in deadline</th><th>Status</th><th>Promo price</th><th>SKUs</th><th /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={8} className="empty">{tab === 'upcoming' ? 'No upcoming promotions. Add the ones you see in the Partner Portal with “+ Add promotion”.' : tab === 'live' ? 'No promotion running now.' : 'No past promotions.'}</td></tr>}
            {list.map((p) => (
              <tr key={p.id}>
                <td style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{p.name}</div><div className="small">{p.source === 'target' ? pill('#eef2ff', '#4338ca', 'from Target') : pill('#f1f5f9', '#475569', 'added by you')}</div>
                  {p.notes && <div className="small muted">{p.notes}</div>}
                  {p.source === 'target' && <div className="small"><a href="#" onClick={(e) => { e.preventDefault(); setShowRaw(showRaw === p.id ? null : p.id); }}>{showRaw === p.id ? 'hide details' : 'all details'}</a>{showRaw === p.id && <pre className="json" style={{ maxWidth: 380 }}>{JSON.stringify(p.raw, null, 2)}</pre>}</div>}
                </td>
                <td className="small">{p.category ?? '—'}</td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmt(p.start_at)}<br />→ {fmt(p.end_at)}</td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{p.deadline_at ? <>{fmt(p.deadline_at)}{p.status === 'planned' && daysLeft(p.deadline_at)! >= 0 ? <div className="warn">{daysLeft(p.deadline_at)} day(s) left</div> : null}</> : '—'}</td>
                <td>{p.status === 'joined' ? pill('#ecfdf5', '#047857', 'Joined') : p.status === 'skipped' ? pill('#f1f5f9', '#64748b', 'Skipped') : pill('#fef3c7', '#92400e', 'Planned')}</td>
                <td className="small">{p.discount_type ? (p.discount_type === 'percent' ? `${p.discount_value}% off` : `$${Number(p.discount_value).toFixed(2)}`) : '—'}
                  {p.source === 'manual' && p.discount_type && p.status === 'joined' && <div className="muted">{tab === 'live' ? 'promo price on Target' : tab === 'upcoming' ? 'sent at start' : p.restored_at ? 'normal price restored' : ''}</div>}</td>
                <td className="small" title={(p.skus ?? []).join(', ')}>{(p.skus ?? []).length || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {p.source === 'manual' && <button className="btn sm" onClick={() => setEdit(p)}>Edit</button>}{' '}
                  {p.source === 'manual' && <button className="btn sm ghost" onClick={() => confirm(`Delete “${p.name}”? If its promo price is on Target, the normal price is sent back.`) && run('d' + p.id, () => del(`/api/promotions/${p.id}`), () => 'Deleted').then(d.reload)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>

      <Card title="Partner Portal link">
        <div className="row" style={{ gap: 8 }}>
          <input defaultValue={d.data.portalUrl} id="portal-url" style={{ maxWidth: 480 }} />
          <Btn size="sm" busy={busy === 'url'} onClick={() => run('url', () => put('/api/promotions/portal-url', { url: (document.getElementById('portal-url') as HTMLInputElement).value }), () => 'Saved').then(d.reload)}>Save link</Btn>
          <span className="small muted">Paste the address of the Partner Portal’s Planning › Promotions page so “Open Partner Portal” goes straight there.</span>
        </div>
      </Card>

      {edit && <PromoModal promo={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={d.reload} />}
    </div>
  );
}

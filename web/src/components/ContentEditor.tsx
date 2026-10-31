import { useEffect, useMemo, useState } from 'react';
import { get, put } from '../lib/api';
import { Btn, Card, ErrorBox, Loading, useAction, useLoad } from './ui';

type F = { key: string; name: string; required: boolean; type: string; multi: boolean; values: string[]; current: string; suggestion: string; edited: boolean; long: boolean };

/**
 * Edit the shared content of a product once: parent title, description, bullets, attributes.
 * Saved values go to every size and color. ✨ Suggest = the hub's own value (from Shopify + your mapping).
 * Sizes, SKUs, barcodes, colors, titles of sizes and images are not edited here.
 */
export default function ContentEditor({ productId, onSaved }: { productId: string; onSaved: () => void }) {
  const d = useLoad(() => get(`/api/products/${productId}/content`), [productId]);
  const { busy, run } = useAction();
  const [val, setVal] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const fields: F[] = d.data?.fields ?? [];
  useEffect(() => { setVal(Object.fromEntries(fields.map((f) => [f.key, f.current]))); }, [d.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => fields.filter((f) => (val[f.key] ?? '') !== f.current), [fields, val]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const set = (k: string, v: string) => setVal((x) => ({ ...x, [k]: v }));
  const shown = fields.filter((f) => (!q || `${f.name} ${f.key}`.toLowerCase().includes(q.toLowerCase())) && (!onlyChanged || dirty.includes(f)));
  const suggestAll = () => setVal((x) => { const n = { ...x }; for (const f of shown) if (f.suggestion) n[f.key] = f.suggestion; return n; });
  const revertAll = () => setVal(Object.fromEntries(fields.map((f) => [f.key, f.current])));
  const save = () => run('save', async () => {
    const r = await put(`/api/products/${productId}/content`, { values: Object.fromEntries(dirty.map((f) => [f.key, val[f.key] ?? ''])) });
    d.reload(); onSaved();
    return r;
  }, (r: any) => `${r.saved} field(s) saved for all ${r.sizes} sizes & colors. Click “Send update to Target” to send them.`);

  return (
    <Card title="Edit content · all sizes & colors" actions={<>
      <input style={{ width: 180 }} placeholder="Find a field…" value={q} onChange={(e) => setQ(e.target.value)} />
      <label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />Only changed</label>
      <Btn size="sm" onClick={suggestAll} title="Fill every field shown with the hub's suggestion">✨ Suggest all</Btn>
      <Btn size="sm" onClick={revertAll} disabled={!dirty.length}>Revert all</Btn>
      <Btn size="sm" kind="primary" busy={busy === 'save'} disabled={!dirty.length} onClick={save}>Save {dirty.length ? `${dirty.length} change(s)` : ''}</Btn>
    </>}>
      <p className="small muted" style={{ marginTop: 0 }}>
        A saved value goes to the parent and <b>every size and color</b>. Sizes, SKUs, barcodes, colors and size titles are never changed here; images are in the Images tab.
        <b> ✨ Suggest</b> = the hub's own value from Shopify and your mapping. Nothing goes to Target until you click <b>Send update to Target</b>. Empty a field to stop sending it.
      </p>
      <div className="stack">
        {shown.map((f) => {
          const v = val[f.key] ?? '';
          const changed = v !== f.current;
          const listId = f.values.length ? `cv-${f.key.replace(/[^a-z0-9]/gi, '')}` : undefined;
          return (
            <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 220px) 1fr auto', gap: 10, alignItems: 'start', padding: '10px 0', borderTop: '1px solid var(--line)', background: changed ? '#fffbeb' : undefined }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.name} {f.required && <span className="small bad">required</span>}</div>
                <div className="small muted mono">{f.key}</div>
                {f.edited && !changed && <div className="small" style={{ color: '#4f46e5' }}>your edit</div>}
                {changed && <div className="small warn">changed · not saved</div>}
              </div>
              <div>
                {f.long || v.length > 90
                  ? <textarea rows={f.long ? 6 : 2} value={v} onChange={(e) => set(f.key, e.target.value)} />
                  : <input value={v} list={listId} onChange={(e) => set(f.key, e.target.value)} placeholder={f.multi ? 'value | value' : ''} />}
                {listId && <datalist id={listId}>{f.values.map((x) => <option key={x} value={x} />)}</datalist>}
                {f.suggestion && f.suggestion !== v && <div className="small muted" style={{ marginTop: 4 }}>✨ Suggestion: <span style={{ color: '#334155' }}>{f.suggestion.length > 220 ? `${f.suggestion.slice(0, 220)}…` : f.suggestion}</span></div>}
                {f.key.startsWith('descriptions.bullets') && v.length > 120 && <div className="small bad">{v.length} characters · max 120</div>}
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <button className="btn sm" disabled={!f.suggestion || f.suggestion === v} onClick={() => set(f.key, f.suggestion)} title="Use the hub's suggestion">✨ Suggest</button>
                <button className="btn sm ghost" disabled={!changed} onClick={() => set(f.key, f.current)}>Revert</button>
              </div>
            </div>
          );
        })}
        {!shown.length && <div className="empty small">No fields.</div>}
      </div>
    </Card>
  );
}

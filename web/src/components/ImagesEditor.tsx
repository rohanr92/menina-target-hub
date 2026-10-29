import { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, useAction, useLoad } from './ui';

type Drag = { url: string; from: string | null; index: number };

const short = (u: string) => decodeURIComponent(u.split('/').pop()?.split('?')[0] ?? u);
const Thumb = ({ url, size = 92, badge, onRemove, ...rest }: { url: string; size?: number; badge?: string; onRemove?: () => void } & React.HTMLAttributes<HTMLDivElement>) => (
  <div {...rest} title={short(url)} style={{ position: 'relative', width: size, height: size, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line, #e5e7eb)', background: '#fff', cursor: rest.draggable ? 'grab' : 'default', flex: '0 0 auto' }}>
    <img src={url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    {badge && <span style={{ position: 'absolute', left: 4, top: 4, background: '#111827', color: '#fff', fontSize: 10, padding: '1px 5px', borderRadius: 4 }}>{badge}</span>}
    {onRemove && <button onClick={onRemove} title="Remove" style={{ position: 'absolute', right: 3, top: 3, width: 20, height: 20, borderRadius: 10, border: 0, background: 'rgba(0,0,0,.6)', color: '#fff', cursor: 'pointer', lineHeight: '18px' }}>×</button>}
  </div>
);

/** Arrange Shopify images per color by drag & drop and send ONLY the images to Target. */
export default function ImagesEditor({ productId }: { productId: string }) {
  const d = useLoad(() => get(`/api/products/${productId}/images`), [productId]);
  const { busy, run } = useAction();
  const [plan, setPlan] = useState<Record<string, string[]>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (!d.data) return;
    const p: Record<string, string[]> = {};
    for (const c of d.data.colors) p[c.color] = c.plan ?? [];
    setPlan(p); setDirty(false);
  }, [d.data]);

  if (!d.data) return <Card><Loading /></Card>;
  const { pool, colors, colorOption } = d.data;

  const change = (fn: (p: Record<string, string[]>) => Record<string, string[]>) => { setPlan((p) => fn({ ...p })); setDirty(true); };
  const dropInto = (color: string, at: number) => {
    if (!drag) return;
    change((p) => {
      const list = [...(p[color] ?? [])];
      let pos = at;
      if (drag.from === color) { list.splice(drag.index, 1); if (drag.index < at) pos--; }
      else if (drag.from) p[drag.from] = (p[drag.from] ?? []).filter((_, i) => i !== drag.index);
      const exists = list.indexOf(drag.url);
      if (exists >= 0) { list.splice(exists, 1); if (exists < pos) pos--; }
      list.splice(Math.max(0, Math.min(pos, list.length)), 0, drag.url);
      p[color] = list;
      return p;
    });
    setDrag(null); setOver(null);
  };
  const save = () => run('save', () => put(`/api/products/${productId}/images`, { plan }), 'Image plan saved').then(() => { setDirty(false); d.reload(); });
  const send = (only?: string) => run('send', async () => {
    if (dirty) await put(`/api/products/${productId}/images`, { plan });
    if (!confirm(`Send ONLY the images to Target${only ? ` for ${only}` : ' for every color'}? All other fields stay exactly as they are on Target.`)) return undefined as any;
    const r = await post(`/api/products/${productId}/images/push`, only ? { colors: [only] } : {});
    setResult(r);
    if (!r.ok) throw new Error(`${r.failed} item(s) failed, see below`);
    return r;
  }, (r: any) => (r ? `Images sent for ${r.sent} item(s). Target will review the new version.` : 'Not sent')).then(() => { setDirty(false); d.reload(); });

  return (
    <div className="stack">
      <Card title="Shopify images" actions={<span className="small muted">Drag an image onto a color below</span>}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {pool.map((u: string) => <Thumb key={u} url={u} draggable onDragStart={() => setDrag({ url: u, from: null, index: -1 })} onDragEnd={() => { setDrag(null); setOver(null); }} />)}
          {!pool.length && <span className="muted small">This product has no images in Shopify.</span>}
        </div>
      </Card>

      {colors.map((c: any) => {
        const list = plan[c.color] ?? [];
        return (
          <Card key={c.color} title={<>{c.color === '_all' ? 'All items' : <>{colorOption}: {c.color}</>} <span className="small muted">· {c.skus.length} SKU(s), {c.linkedCount} on Target</span></>}
            actions={<>
              <Btn size="sm" kind="ghost" onClick={() => change((p) => ({ ...p, [c.color]: c.suggested }))}>Suggest</Btn>
              <Btn size="sm" kind="ghost" disabled={!list.length} onClick={() => change((p) => ({ ...p, [c.color]: [] }))}>Clear</Btn>
              <Btn size="sm" disabled={!list.length || !c.linkedCount} busy={busy === 'send'} onClick={() => send(c.color)}>Send this color</Btn>
            </>}>
            <div className="small muted" style={{ marginBottom: 6 }}>New order (1st = main image). Drag to reorder, × to remove.</div>
            <div
              className="row"
              onDragOver={(e) => { e.preventDefault(); setOver(c.color); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); dropInto(c.color, list.length); }}
              style={{ flexWrap: 'wrap', gap: 8, minHeight: 104, padding: 6, borderRadius: 10, border: `2px dashed ${over === c.color ? '#4f46e5' : '#d1d5db'}`, background: over === c.color ? '#eef2ff' : 'transparent' }}>
              {list.map((u, i) => (
                <Thumb key={u + i} url={u} badge={i === 0 ? 'Main' : String(i + 1)} draggable
                  onDragStart={(e) => { e.stopPropagation(); setDrag({ url: u, from: c.color, index: i }); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(c.color); }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropInto(c.color, i); }}
                  onRemove={() => change((p) => ({ ...p, [c.color]: list.filter((_, j) => j !== i) }))} />
              ))}
              {!list.length && <span className="muted small" style={{ alignSelf: 'center' }}>Drop images here, or click “Suggest”.</span>}
            </div>
            <div className="small muted" style={{ margin: '10px 0 6px' }}>Now on Target {c.onTargetFetchedAt ? `(loaded ${ago(c.onTargetFetchedAt)})` : ''}</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {c.onTarget.map((u: string, i: number) => <Thumb key={u + i} url={u} size={64} badge={i === 0 ? 'Main' : undefined} />)}
              {!c.onTarget.length && <span className="muted small">—</span>}
            </div>
          </Card>
        );
      })}

      <div className="row">
        <Btn busy={busy === 'save'} disabled={!dirty} onClick={save}>Save image plan</Btn>
        <Btn kind="primary" busy={busy === 'send'} onClick={() => send()}>Send images to Target (all colors)</Btn>
        <span className="small muted">Only the image fields change. Title, attributes and everything else stay as they are on Target.</span>
      </div>
      {result && (
        <Card title="Last send">
          <table className="table small"><tbody>
            {result.results.map((r: any, i: number) => <tr key={i}><td className="mono">{r.sku}</td><td>{r.color}</td><td className={r.action === 'failed' ? 'bad' : r.action === 'skipped' ? 'muted' : 'ok'}>{r.action}{r.count ? ` (${r.count})` : ''}</td><td className="muted">{r.reason ?? ''}</td></tr>)}
          </tbody></table>
        </Card>
      )}
    </div>
  );
}

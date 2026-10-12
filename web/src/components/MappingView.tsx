import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, Status, useAction, useLoad } from './ui';

/** Shows, for each Target item of a product: attribute → value we send → where it came from → value on Target now. */
export default function MappingView({ productId, itemTypeId }: { productId: string; itemTypeId?: string | null }) {
  const d = useLoad(() => get(`/api/products/${productId}/mapping`), [productId]);
  const [sel, setSel] = useState(0);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const { busy, run } = useAction();
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <div className="bad small">{d.error}</div>;
  const items: any[] = d.data.items ?? [];
  if (!items.length) return <div className="muted small">Choose an item type first: the mapping is built from that item type’s Target attributes.</div>;
  const it = items[Math.min(sel, items.length - 1)];
  const anyOnTarget = items.some((x) => x.targetProductId);
  const rows = onlyDiff ? it.rows.filter((r: any) => r.differs) : it.rows;
  return (
    <div className="stack">
      <div className="row between">
        <div className="row" style={{ gap: 4 }}>
          {items.map((x, i) => (
            <button key={x.scope} className={`btn sm ${i === sel ? 'primary' : ''}`} onClick={() => setSel(i)}>
              {x.level === 'VAP' ? 'Parent' : x.title} {x.targetProductId ? '●' : ''}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="inline-check"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />Only differences with Target</label>
          <Btn size="sm" disabled={!anyOnTarget} busy={busy === 'ft'} onClick={() => run('ft', () => post(`/api/products/${productId}/fetch-target`), 'Loaded what Target has').then(d.reload)}>Fetch what Target has</Btn>
          {itemTypeId && <Link className="btn sm" to={`/taxonomy/${itemTypeId}`}>Edit mapping rules</Link>}
        </div>
      </div>
      <div className="small muted">
        <strong>{it.level}</strong> · SKU <code>{it.sku}</code>
        {it.targetProductId ? <> · on Target: TCIN <code>{it.tcin}</code> <Status value={it.status} /> {it.onTargetFetchedAt ? `· Target values loaded ${ago(it.onTargetFetchedAt)}` : '· click “Fetch what Target has” to compare'}</> : ' · not on Target yet'}
      </div>
      {it.missing.length > 0 && (
        <div className="issue error" style={{ gridTemplateColumns: '16px 1fr' }}><span>✕</span><span>Required but empty: {it.missing.map((m: any) => `${m.name} (${m.key})`).join(', ')}. Set a source on the Mapping page.</span></div>
      )}
      <Card pad={false}>
        <div className="table-wrap"><table>
          <thead><tr><th style={{ width: '22%' }}>Target attribute</th><th style={{ width: '30%' }}>Value we send</th><th style={{ width: '22%' }}>Comes from</th><th>On Target now</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.key}>
                <td><strong>{r.name}</strong> {r.required && <span className="badge solid">required</span>}<div className="small muted mono">{r.key}</div></td>
                <td className="small" style={{ wordBreak: 'break-word' }}>{/^https?:\/\//.test(r.value) ? <a href={r.value} target="_blank" rel="noreferrer">{r.value.split('/').pop()}</a> : r.value.length > 220 ? r.value.slice(0, 220) + '…' : r.value}</td>
                <td className="small">{r.source}{r.original && <div className="muted">Shopify value: “{r.original}”</div>}</td>
                <td className={`small ${r.differs ? 'warn' : ''}`} style={{ wordBreak: 'break-word' }}>{r.onTarget == null ? <span className="muted">—</span> : r.onTarget === '' ? <span className="warn">empty on Target</span> : (r.onTarget.length > 220 ? r.onTarget.slice(0, 220) + '…' : r.onTarget)}{r.differs && <div>≠ will change on next update</div>}</td>
              </tr>
            ))}
            {it.extra?.map((e: any) => (
              <tr key={'x' + e.key} style={{ background: 'var(--bg-2)' }}>
                <td className="small mono">{e.key}</td><td className="small muted">not sent by the hub</td><td className="small muted">only on Target</td><td className="small">{e.onTarget}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    </div>
  );
}

import { Fragment, useEffect, useState } from 'react';
import { get } from '../lib/api';
import { Card, Loading, PageHead, useLoad } from '../components/ui';

const nice = (a: string) => {
  const m: [RegExp, string][] = [
    [/^sign in$/, 'Signed in'], [/^failed sign in$/, 'Failed sign-in'],
    [/bulk\/unlist/, 'Unlisted SKUs'], [/bulk\/disable/, 'Disable / enable SKUs'], [/bulk\/buffer/, 'Changed buffer'], [/bulk\/price-rule/, 'Changed price rule'],
    [/bulk\/send-flag/, 'Changed Send switch'], [/set-price/, 'Set price by hand'], [/set-stock/, 'Set stock by hand'], [/price-holds\/.*approve/, 'Approved held price'],
    [/price-holds\/.*reject/, 'Rejected held price'], [/products\/push-many/, 'Sent products to Target'], [/products\/:id\/push/, 'Sent product to Target'],
    [/images\/push/, 'Sent images to Target'], [/orders\/:id\/ship-cancel-rest/, 'Shipped + canceled rest'], [/orders\/:id\/ship/, 'Shipped order'], [/orders\/:id\/cancel/, 'Canceled order lines'],
    [/settings\/sync/, 'Changed sync settings'], [/settings\/shopify/, 'Changed Shopify settings'], [/settings\/target/, 'Changed Target settings'], [/active-env/, 'Switched environment'],
    [/\/api\/users/, 'Changed users'], [/grid\/cells/, 'Edited product fields'], [/target-catalog\/link/, 'Linked Target items'], [/target-catalog\/adopt/, 'Copied Target data'],
  ];
  return m.find(([r]) => r.test(a))?.[1] ?? a.replace(/^(POST|PUT|PATCH|DELETE) \/api\//, '').replace(/\//g, ' › ');
};

export default function Activity() {
  const [q, setQ] = useState(''); const [qq, setQq] = useState('');
  useEffect(() => { const t = setTimeout(() => setQq(q), 400); return () => clearTimeout(t); }, [q]);
  const d = useLoad(() => get(`/api/audit?limit=500${qq ? `&q=${encodeURIComponent(qq)}` : ''}`), [qq]);
  const [open, setOpen] = useState<number | null>(null);
  const rows: any[] = d.data ?? [];
  return (
    <div className="page">
      <PageHead title="Activity" sub="Every change made in the hub: who did it, when, and what was sent. Passwords and keys are never shown.">
        <input style={{ width: 280 }} placeholder="Search person, action, SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageHead>
      <Card pad={false}>
        {d.loading && !d.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No activity yet.</td></tr>}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString()}</td>
                    <td className="small"><b>{r.actor}</b></td>
                    <td>{nice(r.action)}<div className="small muted mono">{r.target ?? ''}</div></td>
                    <td className="small">{r.status == null ? '—' : r.status < 400 ? <span className="ok">ok</span> : <span className="bad">failed ({r.status})</span>}</td>
                    <td>{r.detail && <button className="btn sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Details'}</button>}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={5}><pre className="json" style={{ maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(r.detail, null, 2)}</pre></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

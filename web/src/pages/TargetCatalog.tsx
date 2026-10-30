import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, PageHead, Status, Tabs, useAction, useLoad } from '../components/ui';

export default function TargetCatalog() {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const d = useLoad(() => get(`/api/target-catalog?filter=${filter}&q=${encodeURIComponent(q)}`), [filter, q]);
  const { busy, run } = useAction();
  const [adopt, setAdopt] = useState<any>(null);
  const pollAdopt = async () => {
    const p = await get('/api/target-catalog/adopt').catch(() => null);
    setAdopt(p);
    if (p?.running) setTimeout(pollAdopt, 3000);
  };
  useEffect(() => { pollAdopt(); }, []);
  const s = d.data?.stats;
  const items: any[] = d.data?.items ?? [];
  const fetchedAt = items[0]?.fetchedAt;
  return (
    <div className="page">
      <PageHead title="Target catalog" sub="Everything that is already on Target, matched to your Shopify products by UPC (then SKU). Linking a match makes the hub update that Target item (stock, price, content) instead of creating a new one.">
        <Btn kind="primary" busy={busy === 'sync'} onClick={() => run('sync', () => post('/api/target-catalog/sync'), (r: any) => `${r.fetched} Target items · ${r.matchedByUpc} matched by UPC · ${r.matchedBySku} by SKU · ${r.unmatched} not in the hub`).then(d.reload)}>1 · Fetch from Target</Btn>
        <Btn busy={busy === 'imp'} disabled={!s?.unmatched} onClick={() => run('imp', () => post('/api/target-catalog/import-unmatched'), (r: any) => `Found ${r.products ?? 0} Shopify products · ${r.notFound?.length ?? 0} codes not in Shopify`).then(d.reload)}>2 · Import unmatched from Shopify (by UPC)</Btn>
        <Btn busy={busy === 'link'} disabled={!s || s.total - s.unmatched === 0} onClick={() => confirm('Link every matched Target item to its Shopify product?\n\nFor these existing items the hub copies the data that is on Target now (title, attributes, images) and locks “Send”, so Shopify data never replaces it. Stock and orders sync when sync is on.') && run('link', () => post('/api/target-catalog/link', {}), (r: any) => `${r.linked} linked · ${r.skipped} skipped · ${r.adopted ?? 0} copied Target data into the hub`).then(d.reload)}>3 · Link matches</Btn>
        <Btn busy={busy === 'adopt' || adopt?.running} onClick={() => confirm('Read every existing item from Target again and use that data in the hub?\n\nThis replaces what the hub shows for these items with what is on Target now. Takes about 15 minutes for ~1,500 items; you can leave the page.') && run('adopt', () => post('/api/target-catalog/adopt', { force: true }), 'Copying Target data into the hub… (about 2 items per second)').then(pollAdopt)}>4 · Copy Target data into hub</Btn>
      </PageHead>
      {adopt && (adopt.running || adopt.finishedAt) && (
        <div className="card" style={{ marginBottom: 12 }}><div className="card-b small">
          {adopt.running ? <>Copying Target data into the hub: <b>{adopt.done}</b> / {adopt.total} items · {adopt.copied} copied · {adopt.fetched} read from Target{adopt.failed ? <span className="bad"> · {adopt.failed} failed</span> : ''}</>
            : <span className={adopt.copied ? 'ok' : 'warn'}>Done: {adopt.copied} items now use Target’s data in the hub · {adopt.fetched} read from Target · {adopt.total} checked{adopt.failed ? ` · ${adopt.failed} failed` : ''}.</span>}
          {adopt.lastError && <div className="bad">Last error: {adopt.lastError}</div>}
        </div></div>
      )}

      {d.data?.env === 'stage' && (
        <div className="card" style={{ marginBottom: 16 }}><div className="card-b small">
          You are on <strong>STAGE</strong>. Stage only contains test items you created here (fake “Valor Fitness” brand and test barcodes), so UPC matching finds little. Your real Target catalog appears here once you switch to <strong>Production</strong> with production keys. Then UPC matching links it to Shopify.
        </div></div>
      )}

      {s && (
        <div className="grid4" style={{ marginBottom: 16 }}>
          <div className="stat"><div className="label">On Target</div><div className="value">{s.total}</div><div className="sub">{s.parents} parents (VAP) · fetched {ago(fetchedAt)}</div></div>
          <div className="stat"><div className="label">Matched</div><div className="value">{s.byUpc + s.bySku}</div><div className="sub">{s.byUpc} by UPC · {s.bySku} by SKU</div></div>
          <div className="stat"><div className="label">Not in hub</div><div className={`value ${s.unmatched ? 'warn' : ''}`}>{s.unmatched}</div><div className="sub">import them from Shopify (step 2)</div></div>
          <div className="stat"><div className="label">Linked</div><div className="value">{s.linked}</div><div className="sub">managed by the hub</div></div>
        </div>
      )}

      <div className="row between">
        <Tabs value={filter} onChange={setFilter} items={[['', 'All'], ['matched', 'Matched'], ['unmatched', 'Not in hub'], ['linked', 'Linked']]} />
        <input style={{ width: 260 }} placeholder="Search SKU, UPC, TCIN, title" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card pad={false}>
        {d.loading && !d.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Type</th><th>TCIN</th><th>SKU (external_id)</th><th>UPC on Target</th><th>Title on Target</th><th>Status</th><th>Shopify match</th><th /></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={8} className="empty">Nothing yet. Click “Fetch from Target”.</td></tr>}
              {items.map((t) => (
                <tr key={t.id} style={t.relationshipType === 'VAP' ? { background: 'var(--bg-2)' } : undefined}>
                  <td><span className="badge">{t.relationshipType}</span></td>
                  <td className="mono small">{t.tcin}</td>
                  <td className="mono small">{t.externalId}</td>
                  <td className="mono small">{t.barcode ?? '—'}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{t.title}<div className="muted">{t.itemTypeName}</div></td>
                  <td><Status value={t.listingStatus} /></td>
                  <td className="small">
                    {t.product ? <><Link to={`/products/${t.product.id}`}>{t.product.title}</Link><div className="muted">by {t.matchBy}{t.linked ? ' · linked' : ''}</div></> : <span className="warn">not in hub</span>}
                  </td>
                  <td>{t.product && !t.linked && <button className="btn sm" onClick={() => run('l1', () => post('/api/target-catalog/link', { ids: [t.id] }), 'Linked').then(d.reload)}>Link</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

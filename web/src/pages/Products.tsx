import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Field, Loading, Modal, PageHead, Status, useAction, useLoad } from '../components/ui';

export default function Products() {
  const [q, setQ] = useState('');
  const [itemTypeId, setItemTypeId] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [shopQuery, setShopQuery] = useState('');
  const [codes, setCodes] = useState('');
  const [codeResult, setCodeResult] = useState<any>(null);
  const list = useLoad(() => get(`/api/products?q=${encodeURIComponent(q)}&itemTypeId=${itemTypeId}&state=${state}&page=${page}`), [q, itemTypeId, state, page]);
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const { busy, run } = useAction();
  const [catResult, setCatResult] = useState<any>(null);
  const nav = useNavigate();
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const items = list.data?.items ?? [];

  return (
    <div className="page">
      <PageHead title="Products" sub="Shopify products become Target items: single-variant products are stand-alone (SA); products with sizes/colors become a parent (VAP) with children (VC).">
        <Btn onClick={() => setImportOpen(true)}>Import…</Btn>
        <Btn onClick={() => nav('/bulk')}>Bulk mapping</Btn>
        <Btn busy={busy === 'refresh'} onClick={() => run('refresh', () => post('/api/products/refresh-all'), (r: any) => `Checked ${r.catalogItems} Target items, updated ${r.updated}`).then(list.reload)}>Refresh Target statuses</Btn>
        <Btn kind="primary" busy={busy === 'cat'} title="For products without an item type: use the category their items already have on Target, and add that category with its fields" onClick={() => run('cat', () => post('/api/products/item-types-from-target').then((r: any) => { setCatResult(r); return r; }), (r: any) => `${r.set} of ${r.products} product(s) got their Target category${r.addedCategories.length ? ` · added: ${r.addedCategories.join(', ')}` : ''}${r.problems.length ? ` · ${r.problems.length} not set: ${r.problems.slice(0, 3).map((x: any) => `${x.product} (${x.error})`).join('; ')}` : ''}`).then(list.reload)}>Set categories from Target</Btn>
      </PageHead>
      {catResult && (
        <div className="card" style={{ marginBottom: 14 }}><div className="card-b small">
          <b>Categories from Target:</b> {catResult.set} of {catResult.products} product(s) without a category got one.
          {catResult.addedCategories.length > 0 && <> New categories added: <b>{catResult.addedCategories.join(', ')}</b> (their fields are loaded; value lists finish in the background).</>}
          {catResult.problems.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{catResult.problems.map((x: any, i: number) => <li key={i}><b>{x.product}</b>: {x.error}</li>)}</ul>}
          {catResult.products === 0 && <> Every product already has a category.</>}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setCatResult(null)}>Close</button>
        </div></div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ width: 280 }} placeholder="Search title, SKU, barcode, TCIN" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select style={{ width: 200 }} value={itemTypeId} onChange={(e) => { setItemTypeId(e.target.value); setPage(1); }}>
          <option value="">All item types</option><option value="none">No item type yet</option>
          {types.data?.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select style={{ width: 180 }} value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}>
          <option value="">Any status</option><option value="not_on_target">Not on Target</option><option value="on_target">On Target</option><option value="errors">Rejected / errors</option>
        </select>
        <span className="muted small">{list.data?.total ?? 0} products</span>
      </div>

      {sel.size > 0 && (
        <div className="sel-bar">
          <strong>{sel.size} selected</strong>
          <select value={bulkType} onChange={(e) => setBulkType(e.target.value)}>
            <option value="">Set item type…</option>
            {types.data?.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn sm" disabled={!bulkType} onClick={() => run('bulk', () => post('/api/products/bulk', { ids: [...sel], itemTypeId: bulkType }), 'Item type set').then(list.reload)}>Apply</button>
          <button className="btn sm" onClick={() => run('pushmany', () => post('/api/products/push-many', { ids: [...sel] }), (r: any[]) => `${r.filter((x) => x.ok).length} sent · ${r.filter((x) => x.blocked).length} blocked by validation · ${r.filter((x) => x.error).length} failed`).then(list.reload)}>{busy === 'pushmany' ? 'Sending…' : 'Send to Target'}</button>
          <button className="btn sm" onClick={() => nav(`/bulk?products=${[...sel].join(',')}`)}>Open in bulk mapping</button>
          <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={items.length > 0 && items.every((p: any) => sel.has(p.id))} onChange={(e) => setSel(e.target.checked ? new Set(items.map((p: any) => p.id)) : new Set())} /></th>
              <th /><th>Product</th><th>Item type</th><th>Structure</th><th className="num">Variants</th><th className="num">Stock</th><th>Target status</th><th>Last sent</th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={9} className="empty">No products. Use Import to pull them from Shopify.</td></tr>}
              {items.map((p: any) => (
                <tr key={p.id} className="click" onClick={() => nav(`/products/${p.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} /></td>
                  <td>{p.image ? <img className="thumb" src={p.image} alt="" /> : <div className="thumb" />}</td>
                  <td><strong>{p.title}</strong><div className="small muted">{p.vendor} · {p.productType} {p.source !== 'shopify' && `· from ${p.source}`}</div></td>
                  <td>{p.itemTypeName ?? <span className="warn small">not set</span>}</td>
                  <td>{p.theme === 'SA' ? 'Stand-alone' : `Variations: ${p.theme}`}</td>
                  <td className="num">{p.variants}</td>
                  <td className="num">{p.inventory}</td>
                  <td><div className="row" style={{ gap: 4 }}>{Object.entries(p.statuses).map(([s, n]) => <span key={s} className="row" style={{ gap: 3 }}><Status value={s} />{(n as number) > 1 && <span className="small muted">×{n as number}</span>}</span>)}</div>{p.lastPushError && <div className="small bad">{p.lastPushError.slice(0, 90)}</div>}</td>
                  <td className="muted small">{ago(p.lastPushedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {list.data && list.data.total > list.data.pageSize && (
        <div className="row" style={{ marginTop: 10 }}>
          <Btn size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Btn>
          <span className="small muted">Page {page} of {Math.ceil(list.data.total / list.data.pageSize)}</span>
          <Btn size="sm" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage(page + 1)}>Next</Btn>
        </div>
      )}

      {importOpen && (
        <Modal title="Import products" onClose={() => setImportOpen(false)}>
          <div className="stack">
            <Card title="From Shopify by UPC / SKU">
              <div className="stack">
                <textarea rows={5} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'Paste UPCs, EANs or SKUs: one per line, or separated by commas/spaces\n012345678905\n8435123456789\nMS-LUC-BLK-37'} />
                <div className="row">
                  <Btn kind="primary" busy={busy === 'codes'} disabled={!codes.trim()} onClick={() => run('codes', async () => { const r = await post('/api/products/import/codes', { codes }); setCodeResult(r); list.reload(); return r; }, (r: any) => `${r.foundCodes} of ${r.searched} codes found · ${r.products} products imported`)}>Import these products</Btn>
                  {codeResult?.products > 0 && <Btn onClick={() => nav('/bulk')}>Map them in bulk →</Btn>}
                  <span className="small muted">Imports the whole Shopify product (all sizes/colors) for each code found.</span>
                </div>
                {codeResult?.notFound?.length > 0 && <div className="small warn">Not found in Shopify ({codeResult.notFound.length}): {codeResult.notFound.slice(0, 40).join(', ')}{codeResult.notFound.length > 40 ? '…' : ''}</div>}
              </div>
            </Card>
            <Card title="From Shopify (search)">
              <div className="stack">
                <Field label="Filter (optional, Shopify search syntax)" hint='Empty uses the filter in Settings. Examples: status:active · vendor:"Menina Step" · tag:target · title:Lucia'>
                  <input value={shopQuery} onChange={(e) => setShopQuery(e.target.value)} />
                </Field>
                <div><Btn kind="primary" busy={busy === 'shop'} onClick={() => run('shop', () => post('/api/products/import/shopify', shopQuery ? { query: shopQuery } : {}), (r: any) => `${r.count} products imported (${r.created} new)`).then(() => { setImportOpen(false); list.reload(); })}>Import from Shopify</Btn></div>
                <span className="small muted">Re-importing updates titles, images, stock and prices but keeps your Target mapping, overrides and IDs.</span>
              </div>
            </Card>
            <Card title="From Marketplace Hub">
              <Btn busy={busy === 'hub'} onClick={() => run('hub', () => post('/api/products/import/hub'), (r: any) => `${r.count} products imported`).then(() => { setImportOpen(false); list.reload(); })}>Import from Marketplace Hub</Btn>
              <div className="small muted" style={{ marginTop: 6 }}>Configure the export URL in Settings › Marketplace Hub.</div>
            </Card>
            <Card title="From a file">
              <div className="stack small">
                <span className="muted">CSV with one row per variant. Columns: product_id, handle, title, description, vendor, product_type, tags, images (separated by |), sku, barcode, size, color, price, compare_at_price, inventory, weight_lb, image. Or a JSON product list.</span>
                <input type="file" accept=".csv,.json" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  const fd = new FormData(); fd.append('file', f);
                  await run('file', () => api('/api/products/import/file', { form: fd }), (r: any) => `${r.count} products imported`);
                  setImportOpen(false); list.reload();
                }} />
              </div>
            </Card>
          </div>
        </Modal>
      )}
    </div>
  );
}

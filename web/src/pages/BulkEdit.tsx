import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, get, post } from '../lib/api';
import { money } from '../lib/format';
import { Btn, Card, Loading, Modal, PageHead, Status, useAction, useLoad, useToast } from '../components/ui';

type Col = { key: string; name: string; type: string; section: string; required: boolean; maxSelections: number; attrId: string | null; values: string[] | null; valueCount: number; description: string | null };
type Row = {
  variantId: string; productId: string; sku: string; productTitle: string; variantTitle: string; options: Record<string, string>;
  image: string | null; productImages: string[]; price: string | null; inventory: number; barcode: string | null; mockBarcode: string | null;
  itemTypeId: string | null; itemTypeName: string | null; theme: string; level: string; listingStatus: string | null; tcin: string | null;
  onTarget: boolean; values: Record<string, string>; sources: Record<string, string>; sourceText: Record<string, string>; errors: string[]; warnings: number;
};

const NONE = '(none)';
const SECTION_LABEL: Record<string, string> = { listing: 'Listing details', variation: 'Variation', required: 'Required attributes', images: 'Images', bullets: 'Feature bullets', optional: 'Optional attributes' };
const isImg = (c: Col) => c.section === 'images';
const PRIMARY = 'digital_assets.images.primary_image_url';
const altNum = (k: string) => Number(k.match(/\[(\d+)\]$/)?.[1] ?? 0);

/** Value lists too big to send with the columns are loaded the first time a cell is used. */
const listCache = new Map<string, Promise<string[]>>();
function loadValues(attrId: string) {
  if (!listCache.has(attrId)) listCache.set(attrId, get(`/api/taxonomy/attributes/${attrId}/values`).then((r: any[]) => r.map((x) => x.name)));
  return listCache.get(attrId)!;
}

async function download(path: string, body: any) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) { let m = `Download failed (${res.status})`; try { m = (await res.json()).error ?? m; } catch { /* */ } throw new Error(m); }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'target-sheet.xlsx';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

// ---------------------------------------------------------------- one editable cell
function Cell({ col, value, source, onCommit, bulk }: { col: Col; value: string; source?: string; onCommit: (v: string) => void; bulk?: boolean }) {
  const [list, setList] = useState<string[] | null>(col.values);
  const listId = col.attrId ? `vl-${col.attrId}` : undefined;
  const cls = ['cell', source ? `src-${source}` : '', !bulk && col.required && !value ? 'missing' : ''].filter(Boolean).join(' ');
  const title = bulk ? `Set ${col.name} for every selected SKU` : source === 'auto' ? 'Filled by Auto-map. Edit to change.' : source === 'shopify' ? 'Automatic value (from Shopify / built-in rule). Type to replace it.' : source === 'none' ? 'Left empty on purpose' : undefined;
  const commit = (v: string) => { if (v.trim() !== (bulk ? '' : value)) onCommit(v.trim()); };

  if (col.type === 'VALUE' && col.maxSelections <= 1 && col.values) {
    const opts = value && !col.values.includes(value) && value !== '' ? [value, ...col.values] : col.values;
    return (
      <select className={cls} title={title} value={bulk ? '' : source === 'none' ? NONE : value} onChange={(e) => onCommit(e.target.value)}>
        <option value="">{bulk ? 'Set for selected…' : value ? '(automatic)' : '—'}</option>
        {opts.map((o) => <option key={o} value={o}>{o}{!col.values!.includes(o) ? ' (not in Target list)' : ''}</option>)}
        <option value={NONE}>(leave empty)</option>
      </select>
    );
  }
  const numeric = ['MEASURE', 'NUMBER', 'INTEGER'].includes(col.type);
  return (
    <>
      <input
        key={value + (source ?? '')}
        className={cls} title={title} list={col.type === 'VALUE' ? listId : undefined} inputMode={numeric ? 'decimal' : undefined}
        defaultValue={bulk ? '' : source === 'none' ? NONE : value}
        placeholder={bulk ? 'Set for selected…' : col.type === 'VALUE' && col.maxSelections > 1 ? `pick up to ${col.maxSelections}, use |` : ''}
        onFocus={() => { if (col.type === 'VALUE' && !list && col.attrId) loadValues(col.attrId).then(setList); }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { (e.target as HTMLInputElement).value = bulk ? '' : value; (e.target as HTMLInputElement).blur(); } }}
      />
      {col.type === 'VALUE' && list && listId && <datalist id={listId}>{list.slice(0, 3000).map((o) => <option key={o} value={o} />)}</datalist>}
    </>
  );
}

// ---------------------------------------------------------------- images
function ImagesModal({ rows, imageCols, onClose, onSaved, bulk }: { rows: Row[]; imageCols: Col[]; onClose: () => void; onSaved: () => void; bulk: boolean }) {
  const first = rows[0];
  const alts = imageCols.filter((c) => c.key !== PRIMARY).sort((a, b) => altNum(a.key) - altNum(b.key));
  const current = [first.values[PRIMARY], ...alts.map((c) => first.values[c.key])].filter((x) => x && x !== NONE) as string[];
  const pool = [...new Set([...rows.flatMap((r) => r.productImages), ...current])];
  const [picked, setPicked] = useState<string[]>(bulk ? [] : current);
  const [url, setUrl] = useState('');
  const [sameColor, setSameColor] = useState(false);
  const { busy, run } = useAction();
  const color = first.values['child_variations.color'] || '';
  const siblings = useLoad(() => (bulk || !color ? Promise.resolve({ rows: [] }) : get(`/api/grid?products=${first.productId}&pageSize=1`)), []);
  const sameColorRows: Row[] = ((siblings.data as any)?.rows ?? []).filter((r: Row) => r.variantId !== first.variantId && r.values['child_variations.color'] === color);
  const toggle = (u: string) => setPicked((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u]));
  const move = (i: number, d: number) => setPicked((p) => { const n = [...p]; const j = i + d; if (j < 0 || j >= n.length) return p; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const targets = [...rows, ...(sameColor ? sameColorRows : [])];
  const save = (reset = false) => run('save', async () => {
    const cells: any[] = [];
    for (const r of targets) {
      cells.push({ variantId: r.variantId, key: PRIMARY, value: reset ? '' : picked[0] ?? NONE });
      alts.forEach((c, i) => cells.push({ variantId: r.variantId, key: c.key, value: reset ? '' : picked[i + 1] ?? NONE }));
    }
    await post('/api/grid/cells', { cells });
    onSaved(); onClose();
  }, reset ? 'Images reset to Shopify' : 'Images saved');

  return (
    <Modal wide title={bulk ? `Images for ${rows.length} selected SKUs` : `Images · ${first.sku}`} onClose={onClose}>
      <div className="stack">
        <div className="small muted">Click images in the order you want them. The first one is the <strong>main image</strong>; the next {alts.length} are additional images. {bulk && 'The same list is set on every selected SKU.'}</div>
        <Card title={`Chosen (${picked.length})`}>
          {picked.length === 0 ? <div className="small muted">Nothing chosen yet. Click images below.</div> : (
            <div className="img-pick">
              {picked.map((u, i) => (
                <div key={u} className="img-tile on">
                  <img src={u} alt="" />
                  <span className="img-n">{i === 0 ? 'Main' : i}</span>
                  <div className="img-act"><button onClick={() => move(i, -1)}>‹</button><button onClick={() => toggle(u)}>✕</button><button onClick={() => move(i, 1)}>›</button></div>
                </div>
              ))}
            </div>
          )}
          {picked.length > alts.length + 1 && <div className="small warn" style={{ marginTop: 8 }}>Target takes 1 main + {alts.length} additional images for this item type; the rest are ignored.</div>}
        </Card>
        <Card title="Available images (from Shopify)">
          <div className="img-pick">
            {pool.map((u) => (
              <button key={u} className={`img-tile ${picked.includes(u) ? 'on' : ''}`} onClick={() => toggle(u)} title={u}>
                <img src={u} alt="" />{picked.includes(u) && <span className="img-n">{picked.indexOf(u) === 0 ? 'Main' : picked.indexOf(u)}</span>}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input style={{ flex: 1 }} placeholder="Or paste an image URL (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Btn size="sm" disabled={!/^https?:\/\//.test(url)} onClick={() => { setPicked((p) => [...p, url.trim()]); setUrl(''); }}>Add</Btn>
          </div>
        </Card>
        {!bulk && sameColorRows.length > 0 && (
          <label className="inline-check"><input type="checkbox" checked={sameColor} onChange={(e) => setSameColor(e.target.checked)} /> Also use these images for the other {sameColorRows.length} size(s) in <strong>{color}</strong></label>
        )}
        <div className="row between">
          <Btn kind="ghost" busy={busy === 'save'} onClick={() => save(true)}>Reset to Shopify images</Btn>
          <Btn kind="primary" busy={busy === 'save'} disabled={!picked.length} onClick={() => save(false)}>Save images{targets.length > 1 ? ` for ${targets.length} SKUs` : ''}</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- SKU detail
function SkuModal({ variantId, onClose, onImages }: { variantId: string; onClose: () => void; onImages: (r: Row, cols: Col[]) => void }) {
  const d = useLoad(() => get(`/api/grid/variant/${variantId}`), [variantId]);
  const [big, setBig] = useState<string | null>(null);
  if (!d.data) return <Modal wide title="SKU" onClose={onClose}><Loading /></Modal>;
  const r: Row = d.data.row, cols: Col[] = d.data.columns;
  const imgs = [r.values[PRIMARY], ...cols.filter((c) => isImg(c) && c.key !== PRIMARY).sort((a, b) => altNum(a.key) - altNum(b.key)).map((c) => r.values[c.key])].filter((x) => x && x !== NONE) as string[];
  const main = big ?? imgs[0] ?? r.image;
  return (
    <Modal wide title={<span>{r.sku} <span className="muted small">· {r.productTitle}</span></span>} onClose={onClose}>
      <div className="sku-detail">
        <div className="stack">
          {main ? <img className="sku-main" src={main} alt="" /> : <div className="sku-main" />}
          <div className="img-strip">{imgs.map((u, i) => <img key={u} src={u} alt="" className={u === main ? 'on' : ''} onClick={() => setBig(u)} title={i === 0 ? 'Main image' : `Additional ${i}`} />)}</div>
          <div className="small muted">{imgs.length} image(s) will be sent to Target{r.productImages.length > imgs.length ? ` · ${r.productImages.length} in Shopify` : ''}</div>
          <Btn size="sm" onClick={() => onImages(r, cols)}>Edit images</Btn>
        </div>
        <div className="stack">
          <div className="kv">
            <div>Product</div><div><Link to={`/products/${r.productId}`}>{r.productTitle}</Link></div>
            <div>Options</div><div>{Object.entries(r.options).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div>
            <div>Item type</div><div>{r.itemTypeName ?? <span className="warn">not set</span>} · {r.level === 'SA' ? 'stand-alone (SA)' : `child (VC) · ${r.theme}`}</div>
            <div>Barcode</div><div>{r.barcode || '—'}{r.mockBarcode ? <span className="muted small"> · stage test {r.mockBarcode}</span> : ''}</div>
            <div>Price · stock</div><div>{money(r.price)} · {r.inventory}</div>
            <div>On Target</div><div className="row" style={{ gap: 6 }}><Status value={r.listingStatus ?? (r.onTarget ? 'SENT' : 'NOT SENT')} />{r.tcin && <span className="small">TCIN {r.tcin}</span>}</div>
          </div>
          {r.errors.length > 0 && <div className="issues">{r.errors.map((e, i) => <div key={i} className="issue error"><span>✕</span><span>{e}</span></div>)}</div>}
        </div>
      </div>
      <div className="table-wrap" style={{ marginTop: 16 }}><table className="tight">
        <thead><tr><th>Target field</th><th>Value sent</th><th>Comes from</th></tr></thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.key}>
              <td><strong>{c.name}</strong>{c.required && <span className="req">required</span>}<div className="small muted mono">{c.key}</div></td>
              <td style={{ maxWidth: 420, wordBreak: 'break-word' }}>{isImg(c) && r.values[c.key] && r.values[c.key] !== NONE ? <img className="thumb" src={r.values[c.key]} alt="" /> : r.values[c.key] || <span className={c.required ? 'bad small' : 'muted'}>{c.required ? 'missing' : '—'}</span>}</td>
              <td className="small muted">{r.sources[c.key] === 'auto' ? 'Auto-map' : r.sources[c.key] === 'variant' ? 'You (this SKU)' : r.sources[c.key] === 'product' ? 'You (whole product)' : r.sourceText[c.key] ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- auto-map dialog
function AutoMapModal({ selected, filter, viewCount, onClose, onDone }: { selected: string[]; filter: any; viewCount: number; onClose: () => void; onDone: () => void }) {
  const [scope, setScope] = useState<'selected' | 'view'>(selected.length ? 'selected' : 'view');
  const [overwrite, setOverwrite] = useState(false);
  const [setType, setSetType] = useState(true);
  const [dims, setDims] = useState({ depth: '', width: '', height: '', weight: '' });
  const [res, setRes] = useState<any>(null);
  const { busy, run } = useAction();
  const go = () => run('map', async () => {
    const defaults = Object.fromEntries(Object.entries(dims).filter(([, v]) => v.trim()));
    const r = await post('/api/grid/automap', { ...(scope === 'selected' ? { variantIds: selected } : { filter }), overwrite, setItemType: setType, defaults });
    setRes(r); onDone(); return r;
  }, (r: any) => `Auto-map filled ${r.cells} value(s) on ${r.skus} SKUs`);
  return (
    <Modal title="Auto-map to Target fields" onClose={onClose}>
      {!res ? (
        <div className="stack">
          <div className="small muted">Reads each SKU's Shopify data (title, options, product type, tags, bullets, description) and picks the matching values from Target's allowed lists for this item type: color family, material, gender, size and so on. Your own edits are kept unless you tick "overwrite".</div>
          <div className="row">
            <label className="inline-check"><input type="radio" checked={scope === 'selected'} disabled={!selected.length} onChange={() => setScope('selected')} /> Selected SKUs ({selected.length})</label>
            <label className="inline-check"><input type="radio" checked={scope === 'view'} onChange={() => setScope('view')} /> Everything in this view ({viewCount} products)</label>
          </div>
          <label className="inline-check"><input type="checkbox" checked={setType} onChange={(e) => setSetType(e.target.checked)} /> Choose the item type automatically when a product has none</label>
          <label className="inline-check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite values I already set by hand</label>
          <Card title="Package size defaults (optional)">
            <div className="small muted" style={{ marginBottom: 8 }}>Shopify doesn't store box dimensions. Enter your standard shoe box once and it fills every SKU that has none (inches / pounds).</div>
            <div className="grid4">
              {(['depth', 'width', 'height', 'weight'] as const).map((k) => <label key={k} className="field"><span>{k[0].toUpperCase() + k.slice(1)} {k === 'weight' ? '(lb)' : '(in)'}</span><input inputMode="decimal" value={dims[k]} placeholder={k === 'weight' ? 'from Shopify' : ''} onChange={(e) => setDims({ ...dims, [k]: e.target.value })} /></label>)}
            </div>
          </Card>
          <div className="row between"><span /><Btn kind="primary" busy={busy === 'map'} onClick={go}>Run auto-map</Btn></div>
        </div>
      ) : (
        <div className="stack">
          <div className="grid3">
            <div className="stat"><div className="label">SKUs checked</div><div className="value">{res.skus}</div></div>
            <div className="stat"><div className="label">Values filled</div><div className="value">{res.cells}</div></div>
            <div className="stat"><div className="label">Item types set</div><div className="value">{res.itemTypesSet}</div></div>
          </div>
          {res.cells === 0 && res.itemTypesSet === 0 && <div className="small muted">Nothing new to fill: every field Auto-map can work out is already set. Tick "Overwrite values I already set" to redo them.</div>}
          {Object.keys(res.filled).length > 0 && <Card title="Filled">{Object.entries(res.filled).map(([k, n]) => <div key={k} className="list-row"><span>{k}</span><span className="v">{n as number} SKU(s)</span></div>)}</Card>}
          {res.noType.length > 0 && <div className="small warn">No item type for {res.noType.length} SKU(s): {res.noType.slice(0, 12).join(', ')}{res.noType.length > 12 ? '…' : ''}. Set it in the Item type column first.</div>}
          {res.valueListsMissing.length > 0 && <div className="small warn">Value lists not loaded for: {res.valueListsMissing.join(', ')}. Open Taxonomy and pull the value lists.</div>}
          {res.stillMissing.length > 0 && (
            <Card title={`Still missing (${res.stillMissing.length} SKUs)`}>
              <div className="small muted" style={{ marginBottom: 6 }}>These required fields couldn't be worked out from Shopify. Fill them in the grid (select rows and use the edit row to do many at once) or with the sheet.</div>
              {res.stillMissing.slice(0, 30).map((m: any) => <div key={m.sku} className="list-row"><span className="mono">{m.sku}</span><span className="small bad">{m.fields.join(', ')}</span></div>)}
            </Card>
          )}
          <div className="row between"><span /><Btn kind="primary" onClick={onClose}>Done</Btn></div>
        </div>
      )}
    </Modal>
  );
}


// ---------------------------------------------------------------- categories (item types) from Target
function AddCategories({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const [name, setName] = useState('');
  const [found, setFound] = useState<{ id: string; name: string }[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [manual, setManual] = useState({ id: '', name: '' });
  const { busy, run } = useAction();
  const search = () => run('find', async () => {
    const r: any = await get(`/api/taxonomy/search?name=${encodeURIComponent(name.trim())}`);
    const list: any[] = Array.isArray(r) ? r : r?.data ?? r?.items ?? r?.taxonomies ?? [];
    setFound(list.map((x) => ({ id: String(x.id ?? x.taxonomy_id ?? ''), name: String(x.name ?? x.taxonomy_name ?? '') })).filter((x) => x.id && x.name));
  });
  const add = (items: { id: string; name: string }[]) => run('add', async () => { await post('/api/grid/add-categories', { items }); onStarted(); onClose(); }, `Adding ${items.length} item type(s) and loading their fields…`);
  return (
    <Modal title="Add your approved categories" onClose={onClose}>
      <div className="stack">
        <div className="small muted">Type a category name exactly like Target shows it (for example <strong>Flats and Slip Ons</strong>, <strong>Boots</strong>, <strong>Heels</strong>), search, tick it and click Add. Target Hub then loads that category's fields and dropdown values.</div>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="Category name, e.g. Sandals" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && search()} />
          <Btn kind="primary" busy={busy === 'find'} disabled={!name.trim()} onClick={search}>Search Target</Btn>
        </div>
        {found && (found.length === 0 ? <div className="small warn">Nothing found for "{name}". Try a shorter word (e.g. "Flats").</div> : (
          <Card title={`Found ${found.length}`}>
            {found.map((f) => (
              <label key={f.id} className="list-row" style={{ cursor: 'pointer' }}>
                <span><input type="checkbox" style={{ width: 16, minHeight: 0, marginRight: 8 }} checked={!!pick[f.id]} onChange={(e) => setPick((p) => { const n = { ...p }; if (e.target.checked) n[f.id] = f.name; else delete n[f.id]; return n; })} />{f.name}</span>
                <code className="small">{f.id}</code>
              </label>
            ))}
          </Card>
        ))}
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>I know the item type ID</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ width: 160 }} placeholder="Item type ID" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} />
            <input style={{ flex: 1 }} placeholder="Name (e.g. Flats and Slip Ons)" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
            <Btn disabled={!manual.id.trim() || !manual.name.trim()} busy={busy === 'add'} onClick={() => add([{ id: manual.id.trim(), name: manual.name.trim() }])}>Add</Btn>
          </div>
        </details>
        <div className="row between"><span className="small muted">{Object.keys(pick).length} selected</span>
          <Btn kind="primary" busy={busy === 'add'} disabled={!Object.keys(pick).length} onClick={() => add(Object.entries(pick).map(([id, n]) => ({ id, name: n })))}>Add selected</Btn></div>
      </div>
    </Modal>
  );
}

function CategorySetup({ types, onDone }: { types: any[]; onDone: () => void }) {
  const [st, setSt] = useState<any>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { busy, run } = useAction();
  const poll = useRef<any>(null);
  const watch = () => {
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await get('/api/grid/setup-categories').catch(() => null);
      setSt(s);
      if (s && !s.running) { clearInterval(poll.current); onDone(); }
    }, 2500);
  };
  useEffect(() => { get('/api/grid/setup-categories').then((s) => { setSt(s); if (s.running) watch(); }).catch(() => {}); return () => clearInterval(poll.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (body: any) => run('setup', async () => { setSt(await post('/api/grid/setup-categories', body)); watch(); });
  const noFields = types.filter((t) => !t.attrs);
  const modal = addOpen && <AddCategories onClose={() => setAddOpen(false)} onStarted={() => { setSt({ running: true, step: 'Starting…', done: 0, total: 0 }); watch(); }} />;
  if (st?.running) {
    return (
      <div className="setup-bar">
        <span className="spin" />
        <div style={{ flex: 1 }}><strong>Loading your Target categories…</strong><div className="small">{st.step}{st.total ? ` · ${st.done}/${st.total} item types` : ''}</div>
          {st.total > 0 && <div className="progress" style={{ marginTop: 6, width: 280 }}><div style={{ width: `${(st.done / st.total) * 100}%` }} /></div>}</div>
      </div>
    );
  }
  const errorBox = st?.error && (
    <div className="small bad" style={{ marginTop: 8 }}>
      <strong>It didn't work:</strong> {st.error}
      <div className="muted" style={{ marginTop: 4 }}>No problem: use <strong>Add categories by name</strong> instead (type "Flats and Slip Ons", "Boots"… and add them). You can also send this message to your developer.</div>
    </div>
  );
  if (!types.length) {
    return (
      <div className="setup-bar big">
        <div style={{ flex: 1 }}>
          <strong>Step 1 · Load your Target categories (item types)</strong>
          <div className="small">Your approved categories (Boots, Flats and Slip Ons, Heels, Sandals…) are already approved on Target. Target Hub just needs to download them once, with their fields and dropdown values. Click the blue button; it takes a few minutes.</div>
          {errorBox}
        </div>
        <div className="stack" style={{ flex: 'none' }}>
          <Btn kind="primary" busy={busy === 'setup'} onClick={() => start({})}>Load my categories from Target</Btn>
          <Btn onClick={() => setAddOpen(true)}>Add categories by name</Btn>
        </div>
        {modal}
      </div>
    );
  }
  if (noFields.length) {
    return (
      <div className="setup-bar">
        <div style={{ flex: 1 }}><strong>{noFields.length} of {types.length} item types have no fields loaded yet</strong><div className="small">{noFields.slice(0, 6).map((t) => t.name).join(', ')}{noFields.length > 6 ? '…' : ''}. Their products only show basic fields until the fields are loaded.</div>{errorBox}</div>
        <Btn kind="primary" busy={busy === 'setup'} onClick={() => start({ onlyIds: noFields.map((t) => t.id) })}>Load their fields</Btn>
        <Btn onClick={() => setAddOpen(true)}>Add category</Btn>
        {modal}
      </div>
    );
  }
  return (
    <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
      <span className="small muted">{types.length} categories loaded · </span>
      <button className="link-btn small" onClick={() => setAddOpen(true)}>add another category</button>
      <span className="small muted">·</span>
      <button className="link-btn small" onClick={() => start({ skipReport: true })}>reload fields</button>
      {errorBox}
      {modal}
    </div>
  );
}

// ---------------------------------------------------------------- page
export default function BulkEdit() {
  const [params, setParams] = useSearchParams();
  const productFilter = params.get('products') ?? '';
  const tabs = useLoad(() => get('/api/grid/tabs'));
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const [itemTypeId, setItemTypeId] = useState<string>(params.get('itemType') ?? '');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [mode, setMode] = useState<'required' | 'all'>('required');
  const [colQ, setColQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [skuOpen, setSkuOpen] = useState<string | null>(null);
  const [images, setImages] = useState<{ rows: Row[]; cols: Col[]; bulk: boolean } | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [upload, setUpload] = useState<any>(null);
  const [bulkNonce, setBulkNonce] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  // pick a sensible first tab: the item type with most products, else "no item type"
  useEffect(() => {
    if (itemTypeId || !tabs.data) return;
    const typed = (tabs.data as any[]).filter((t) => t.id !== 'none').sort((a, b) => b.skus - a.skus);
    setItemTypeId(productFilter ? 'all' : typed[0]?.id ?? 'none');
  }, [tabs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const filter = { itemTypeId: itemTypeId === 'all' ? '' : itemTypeId, q, state, products: productFilter };
  const grid = useLoad(
    () => (itemTypeId ? get(`/api/grid?itemTypeId=${itemTypeId === 'all' ? '' : itemTypeId}&q=${encodeURIComponent(q)}&state=${state}&products=${productFilter}&page=${page}&pageSize=${pageSize}`) : Promise.resolve(null)),
    [itemTypeId, q, state, page, pageSize, productFilter],
  );
  const rows: Row[] = grid.data?.rows ?? [];
  const allCols: Col[] = grid.data?.columns ?? [];
  const typed = !!itemTypeId && itemTypeId !== 'none' && itemTypeId !== 'all';
  const cols = useMemo(() => {
    let c = allCols;
    if (mode === 'required') c = c.filter((x) => x.required || x.section === 'listing' || x.section === 'variation' || x.key === PRIMARY || (x.section === 'bullets' && altNum(x.key) <= 3));
    if (colQ.trim()) c = c.filter((x) => `${x.name} ${x.key}`.toLowerCase().includes(colQ.trim().toLowerCase()));
    return c.filter((x) => !(isImg(x) && x.key !== PRIMARY)); // additional images live in the Images column
  }, [allCols, mode, colQ]);
  const imageCols = allCols.filter(isImg);
  const sections = cols.reduce((acc: { s: string; n: number }[], c) => { const last = acc[acc.length - 1]; if (last?.s === c.section) last.n++; else acc.push({ s: c.section, n: 1 }); return acc; }, []);
  const selRows = rows.filter((r) => sel.has(r.variantId));

  const reload = () => { grid.reload(); tabs.reload(); types.reload(); };
  const saveCell = (r: Row, key: string, value: string) => run('cell', async () => { await post('/api/grid/cells', { cells: [{ variantId: r.variantId, key, value }] }); reload(); });
  const saveBulk = (key: string, value: string) => {
    if (!sel.size) return;
    run('bulk', async () => { await post('/api/grid/bulk', { variantIds: [...sel], key, value }); setBulkNonce((n) => n + 1); reload(); }, `${key === '__itemType' ? 'Item type' : 'Value'} set on ${sel.size} SKU(s)`);
  };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectProduct = (pid: string) => setSel((s) => { const ids = rows.filter((r) => r.productId === pid).map((r) => r.variantId); const n = new Set(s); const all = ids.every((i) => n.has(i)); ids.forEach((i) => (all ? n.delete(i) : n.add(i))); return n; });

  const sheet = (kind: 'selected' | 'view' | 'blank') => run('sheet', () => download('/api/grid/sheet', {
    itemTypeId, blank: kind === 'blank', variantIds: kind === 'selected' ? [...sel] : undefined, filter: kind === 'view' ? filter : undefined,
  }), (n: string) => `Downloaded ${n}`).then(() => setSheetOpen(false));

  const onUpload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    const r = await run('upload', () => api('/api/grid/sheet/upload', { form: fd }), (x: any) => `${x.cellsChanged} value(s) updated on ${x.skusChanged} SKU(s)`);
    if (fileRef.current) fileRef.current.value = '';
    if (r) { setUpload(r); reload(); }
  };

  const tabList: any[] = tabs.data ?? [];
  return (
    <div className="page page-wide">
      <PageHead title="Bulk mapping" sub="Every SKU in one grid. Fill Target fields one by one, select rows to set many at once, let Auto-map fill them from Shopify, or work in Excel and upload.">
        <Btn onClick={() => setAutoOpen(true)}>✨ Auto-map</Btn>
        <div className="menu-wrap">
          <Btn disabled={!typed} title={typed ? '' : 'Pick an item type tab first'} onClick={() => setSheetOpen(!sheetOpen)}>Download sheet ▾</Btn>
          {sheetOpen && typed && (
            <div className="menu" onMouseLeave={() => setSheetOpen(false)}>
              <button disabled={!sel.size} onClick={() => sheet('selected')}>Selected SKUs ({sel.size})</button>
              <button onClick={() => sheet('view')}>All SKUs in this tab</button>
              <button onClick={() => sheet('blank')}>Blank template (with dropdowns)</button>
            </div>
          )}
        </div>
        <Btn busy={busy === 'upload'} onClick={() => fileRef.current?.click()}>Upload sheet</Btn>
        <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
      </PageHead>

      <CategorySetup types={types.data ?? []} onDone={() => { types.reload(); reload(); }} />
      <div className="tabs">
        {productFilter && <button className={itemTypeId === 'all' ? 'on' : ''} onClick={() => { setItemTypeId('all'); setPage(1); }}>Chosen products</button>}
        {tabList.map((t) => (
          <button key={t.id} className={itemTypeId === t.id ? 'on' : ''} onClick={() => { setItemTypeId(t.id); setPage(1); setSel(new Set()); }}>
            {t.name} <span className="tab-n">{t.skus}</span>
          </button>
        ))}
      </div>
      {productFilter && <div className="small muted" style={{ margin: '-8px 0 12px' }}>Showing {productFilter.split(',').length} product(s) picked on the Products page · <a href="#" onClick={(e) => { e.preventDefault(); params.delete('products'); setParams(params); setItemTypeId(''); }}>show all</a></div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ width: 260 }} placeholder="Search title, SKU, barcode, TCIN" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select style={{ width: 170 }} value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}>
          <option value="">Any status</option><option value="not_on_target">Not on Target</option><option value="on_target">On Target</option>
        </select>
        <div className="seg">
          <button className={mode === 'required' ? 'on' : ''} onClick={() => setMode('required')}>Required fields</button>
          <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All fields ({allCols.length})</button>
        </div>
        <input style={{ width: 200 }} placeholder="Find a field…" value={colQ} onChange={(e) => setColQ(e.target.value)} />
        <span className="muted small">{grid.data?.total ?? 0} products · {rows.length} SKUs on this page</span>
      </div>
      {!typed && itemTypeId === 'none' && <div className="hint-bar">These products have no Target item type yet, so only the basic fields are shown. Pick the item type in the <strong>Item type</strong> column (or select rows and set it for all), or run <strong>Auto-map</strong> to choose it from the product type. Then they move to that item type's tab with all its fields.</div>}

      {sel.size > 0 && (
        <div className="sel-bar">
          <strong>{sel.size} selected</strong>
          <span className="small" style={{ opacity: .8 }}>Use the blue row in the table to set a field for all of them.</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setAutoOpen(true)}>Auto-map selected</button>
          <button className="btn sm" onClick={() => setImages({ rows: selRows, cols: imageCols, bulk: true })} disabled={!selRows.length}>Set images</button>
          <button className="btn sm" onClick={() => run('push', async () => {
            const ids = [...new Set(selRows.map((r) => r.productId))];
            if (!confirm(`Send ${ids.length} product(s) to Target now?`)) return null;
            return post('/api/products/push-many', { ids });
          }, (r: any) => (r ? `${r.filter((x: any) => x.ok).length} sent · ${r.filter((x: any) => x.blocked).length} blocked by errors · ${r.filter((x: any) => x.error).length} failed` : 'Cancelled')).then(reload)}>{busy === 'push' ? 'Sending…' : 'Send to Target'}</button>
          <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <Card pad={false}>
        {(grid.loading && !grid.data) || !itemTypeId ? <Loading /> : rows.length === 0 ? <div className="empty">No SKUs here. Import products on the Products page (Import › From Shopify by UPC / SKU).</div> : (
          <div className="grid-wrap"><table className="grid">
            <thead>
              <tr className="grp">
                <th className="stick s0" colSpan={3}>Shopify</th>
                <th colSpan={3}>Target+ status</th>
                <th colSpan={2}>Setup</th>
                {sections.map((s) => <th key={s.s} colSpan={s.n} className={`sec-${s.s}`}>{SECTION_LABEL[s.s] ?? s.s}</th>)}
              </tr>
              <tr>
                <th className="stick s0"><input type="checkbox" checked={rows.length > 0 && rows.every((r) => sel.has(r.variantId))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.variantId)) : new Set())} /></th>
                <th className="stick s1">SKU</th>
                <th className="stick s2">Product</th>
                <th>Price</th><th>Listing</th><th>TCIN</th>
                <th>Item type</th><th>Images</th>
                {cols.map((c) => <th key={c.key} title={`${c.key}${c.description ? `\n${c.description}` : ''}`} className={c.required ? 'req-h' : ''}>{c.name}{c.required && <span className="req-dot">*</span>}</th>)}
              </tr>
            </thead>
            <tbody>
              {sel.size > 0 && (
                <tr className="bulk-row">
                  <td className="stick s0" />
                  <td className="stick s1" colSpan={2}><strong>{sel.size} selected</strong><div className="small">edit this row to update them all</div></td>
                  <td colSpan={3} />
                  <td>
                    <select value="" onChange={(e) => e.target.value && saveBulk('__itemType', e.target.value)}>
                      <option value="">{(types.data ?? []).length ? 'Set item type…' : 'Load categories first ↑'}</option>
                      {(types.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </td>
                  <td><button className="btn sm" onClick={() => setImages({ rows: selRows, cols: imageCols, bulk: true })}>Set…</button></td>
                  {cols.map((c) => <td key={c.key}><Cell key={`${c.key}-${bulkNonce}`} bulk col={c} value="" onCommit={(v) => saveBulk(c.key, v)} /></td>)}
                </tr>
              )}
              {rows.map((r, i) => {
                const firstOfProduct = i === 0 || rows[i - 1].productId !== r.productId;
                const imgCount = imageCols.filter((c) => r.values[c.key] && r.values[c.key] !== NONE).length;
                return (
                  <tr key={r.variantId} className={`${sel.has(r.variantId) ? 'sel' : ''} ${firstOfProduct ? 'pfirst' : ''}`}>
                    <td className="stick s0"><input type="checkbox" checked={sel.has(r.variantId)} onChange={() => toggle(r.variantId)} /></td>
                    <td className="stick s1">
                      <button className="link-btn mono" onClick={() => setSkuOpen(r.variantId)}>{r.sku || '(no SKU)'}</button>
                      {r.errors.length > 0 && <span className="err-n" title={r.errors.join('\n')}>{r.errors.length}</span>}
                      <div className="small muted">{Object.values(r.options).join(' / ') || r.level}</div>
                    </td>
                    <td className="stick s2">
                      <div className="prod-cell">
                        {r.image ? <img className="thumb sm" src={r.image} alt="" /> : <div className="thumb sm" />}
                        <div>
                          <div className="ellipsis" title={r.productTitle}>{r.productTitle}</div>
                          {firstOfProduct && rows.filter((x) => x.productId === r.productId).length > 1 && <button className="link-btn small" onClick={() => selectProduct(r.productId)}>select all sizes</button>}
                        </div>
                      </div>
                    </td>
                    <td className="num">{money(r.price)}<div className="small muted">{r.inventory} in stock</div></td>
                    <td><Status value={r.listingStatus ?? (r.onTarget ? 'SENT' : null)} /></td>
                    <td className="small mono">{r.tcin ?? '—'}</td>
                    <td>
                      <select className={!r.itemTypeId ? 'cell missing' : 'cell'} value={r.itemTypeId ?? ''} onChange={(e) => saveCell(r, '__itemType', e.target.value)}>
                        <option value="">{(types.data ?? []).length ? '— choose —' : 'Load categories first ↑'}</option>
                        {(types.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <button className="img-cell" onClick={() => setImages({ rows: [r], cols: imageCols.length ? imageCols : [{ key: PRIMARY } as Col], bulk: false })} title="Choose images for this SKU">
                        {r.values[PRIMARY] && r.values[PRIMARY] !== NONE ? <img src={r.values[PRIMARY]} alt="" /> : <span className="bad small">none</span>}
                        <span className="small">{imgCount}</span>
                      </button>
                    </td>
                    {cols.map((c) => <td key={c.key}><Cell col={c} value={r.values[c.key] ?? ''} source={r.sources[c.key]} onCommit={(v) => saveCell(r, c.key, v)} /></td>)}
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
      <div className="row" style={{ marginTop: 10 }}>
        <Btn size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Btn>
        <span className="small muted">Page {page} of {Math.max(1, Math.ceil((grid.data?.total ?? 0) / pageSize))}</span>
        <Btn size="sm" disabled={page * pageSize >= (grid.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Next</Btn>
        <select style={{ width: 150 }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
          {[25, 50, 100].map((n) => <option key={n} value={n}>{n} products / page</option>)}
        </select>
        <span className="legend"><span className="lg src-manual" /> your value <span className="lg src-auto" /> auto-mapped <span className="lg src-shopify" /> automatic (Shopify) <span className="lg missing" /> required, empty</span>
      </div>

      {skuOpen && <SkuModal variantId={skuOpen} onClose={() => setSkuOpen(null)} onImages={(r, c) => setImages({ rows: [r], cols: c.filter(isImg), bulk: false })} />}
      {images && <ImagesModal rows={images.rows} imageCols={images.cols.length ? images.cols : [{ key: PRIMARY } as Col]} bulk={images.bulk} onClose={() => setImages(null)} onSaved={() => { reload(); if (skuOpen) { const id = skuOpen; setSkuOpen(null); setTimeout(() => setSkuOpen(id), 0); } }} />}
      {autoOpen && <AutoMapModal selected={[...sel]} filter={filter} viewCount={grid.data?.total ?? 0} onClose={() => setAutoOpen(false)} onDone={reload} />}
      {upload && (
        <Modal title="Sheet uploaded" onClose={() => setUpload(null)}>
          <div className="stack">
            <div className="grid3">
              <div className="stat"><div className="label">Rows read</div><div className="value">{upload.rows}</div></div>
              <div className="stat"><div className="label">SKUs changed</div><div className="value">{upload.skusChanged}</div></div>
              <div className="stat"><div className="label">Values updated</div><div className="value">{upload.cellsChanged}</div></div>
            </div>
            {upload.parentsUpdated > 0 && <div className="small">{upload.parentsUpdated} parent (VAP) row(s) updated.</div>}
            {upload.unknown.length > 0 && <div className="small warn">SKUs not found in Target Hub ({upload.unknown.length}): {upload.unknown.slice(0, 30).join(', ')}{upload.unknown.length > 30 ? '…' : ''}. Import them first (Products › Import by UPC / SKU).</div>}
            {upload.warnings.length > 0 && <Card title={`Check these (${upload.warnings.length + upload.moreWarnings})`}>{upload.warnings.map((w: string, i: number) => <div key={i} className="small warn">{w}</div>)}</Card>}
            <div className="small muted">Values were saved. Values not in Target's list are kept but Target may reject them, so fix them in the grid.</div>
            <div className="row between"><span /><Btn kind="primary" onClick={() => { setUpload(null); toast('Grid refreshed'); }}>Done</Btn></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

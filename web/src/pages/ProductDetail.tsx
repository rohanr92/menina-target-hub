import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api';
import { ago, money } from '../lib/format';
import { Btn, Card, Copy, ErrorBox, Field, Json, Loading, Modal, PageHead, Status, Tabs, useAction, useLoad } from '../components/ui';
import MappingView from '../components/MappingView';

function Issues({ issues }: { issues: any[] }) {
  if (!issues?.length) return <div className="ok small">✓ No problems found. Ready to send.</div>;
  const errors = issues.filter((i) => i.level === 'error').length;
  return (
    <div className="stack">
      <div className="small"><span className="bad">{errors} error(s)</span> · <span className="warn">{issues.length - errors} warning(s)</span>. Errors block sending (you can still force it).</div>
      <div className="issues">
        {issues.map((i, n) => <div key={n} className={`issue ${i.level}`}><span>{i.level === 'error' ? '✕' : '!'}</span><span className="scope" title={i.scope}>{i.scope}</span><span>{i.message}</span></div>)}
      </div>
    </div>
  );
}

function Overrides({ value, onSave, keys }: { value: Record<string, any>; onSave: (v: Record<string, any>) => void; keys: string[] }) {
  const [rows, setRows] = useState<[string, string][]>(Object.entries(value ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join('|') : String(v)]));
  return (
    <div className="stack small">
      {rows.map(([k, v], i) => (
        <div key={i} className="row">
          <input list="attr-keys" style={{ width: 260 }} value={k} placeholder="attribute (e.g. 107707 or brands.name)" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input style={{ flex: 1, width: 'auto' }} value={v} placeholder="value (use | for multiple)" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button className="btn ghost sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <datalist id="attr-keys">{keys.map((k) => <option key={k} value={k} />)}</datalist>
      <div className="row">
        <button className="btn sm" onClick={() => setRows([...rows, ['', '']])}>Add override</button>
        <button className="btn sm primary" onClick={() => onSave(Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])))}>Save overrides</button>
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const d = useLoad(() => get(`/api/products/${id}`), [id]);
  const preview = useLoad(() => get(`/api/products/${id}/preview`), [id]);
  const types = useLoad(() => get('/api/taxonomy/item-types'));
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'mapping' | 'items' | 'content' | 'json' | 'logistics'>('mapping');
  const [bullets, setBullets] = useState<string>('');
  const [live, setLive] = useState<any>(null);
  const [lastResult, setLastResult] = useState<any>(null);
  useEffect(() => { if (d.data) setBullets((d.data.product.bullets ?? []).join('\n')); }, [d.data]);
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (d.error) return <div className="page"><ErrorBox error={d.error} /></div>;
  const { product: p, variants, detected } = d.data;
  const pv = preview.data;
  const reloadAll = () => { d.reload(); preview.reload(); };
  const save = (body: any, msg = 'Saved') => run('save', () => patch(`/api/products/${id}`, body), msg).then(reloadAll);
  const push = (force = false) => run('push', async () => {
    // first send: show exactly what Target will receive. A family's structure can't be changed after it's created.
    if (!variants.some((v: any) => v.targetProductId)) {
      const inc = variants.filter((v: any) => v.syncEnabled);
      const so = p.sizeOption || detected.sizeOption, co = p.colorOption || detected.colorOption;
      const uniq = (o: string | null) => (o ? [...new Set(inc.map((v: any) => v.options?.[o]).filter(Boolean))] : []) as string[];
      const theme = detected.theme;
      const what = theme === 'SA'
        ? `STAND-ALONE item${inc.length > 1 ? 's' : ''} (no parent): ${inc.map((v: any) => v.sku).join(', ')}`
        : `PARENT ${pv?.parent?.external_id ?? p.parentExternalId ?? '(VAP)'} with ${inc.length} child item(s)\nVariation theme: ${theme.toUpperCase()}`;
      const msg = `First send to Target. Please check, this can't be changed later:\n\n${what}\nColors: ${uniq(co).join(', ') || '-'}\nSizes: ${uniq(so).join(', ') || '-'}\n${inc.length} of ${variants.length} SKUs included (the rest are excluded)\n\nSend now?`;
      if (!confirm(msg)) return undefined as any;
    }
    const r = await post(`/api/products/${id}/push`, { force });
    setLastResult(r);
    if (r.blocked) throw new Error('Fix the errors below first (or use “Send anyway”).');
    if (!r.ok) throw new Error(r.error ?? 'Target rejected the request');
    return r;
  }, (r: any) => (r ? 'Sent to Target. Price and inventory are queued.' : 'Not sent')).then(reloadAll);
  const optionNames: string[] = p.optionNames ?? [];
  const keys = [...new Set((pv?.items?.[0]?.payload?.fields ?? []).map((f: any) => f.name))] as string[];
  const onTarget = variants.some((v: any) => v.targetProductId);
  const keepTarget = [true, 'true'].includes(p.overrides?.keep_target_content);

  return (
    <div className="page">
      <PageHead title={p.title} sub={<><Link to="/products">Products</Link> · {p.vendor} · {p.productType} · {p.source}</>}>
        <Btn busy={busy === 'refresh'} disabled={!onTarget} onClick={() => run('refresh', () => post(`/api/products/${id}/refresh`), (r: any) => `Statuses refreshed${r?.tcinsFound ? ` · ${r.tcinsFound} TCIN(s) found` : ''}`).then(reloadAll)}>Refresh status</Btn>
        <Btn busy={busy === 'pi'} disabled={!onTarget} onClick={() => run('pi', () => post(`/api/products/${id}/price-inventory`), (r: any) => `Queued price + inventory for ${r.queued} item(s)`)}>Send price & inventory</Btn>
        <label className="small" title="Existing Target items keep the content already on Target. Stock and orders still sync." style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={keepTarget} onChange={(e) => {
            if (!e.target.checked && !confirm('Allow the hub to send its own content (title, attributes, images) over what is on Target now?')) return;
            save({ overrides: { ...(p.overrides ?? {}), keep_target_content: e.target.checked } }, e.target.checked ? 'Keeping Target content' : 'Hub content can be sent now');
          }} /> Keep Target content
        </label>
        <Btn kind="primary" busy={busy === 'push'} disabled={keepTarget} title={keepTarget ? 'Locked: this product keeps the content already on Target' : ''} onClick={() => push(false)}>{onTarget ? 'Send update to Target' : 'Send to Target'}</Btn>
      </PageHead>

      <div className="grid3" style={{ marginBottom: 16 }}>
        <Card title="Target setup">
          <div className="stack">
            <Field label="Item type">
              <select value={p.itemTypeId ?? ''} onChange={(e) => save({ itemTypeId: e.target.value })}>
                <option value="">— choose —</option>
                {types.data?.map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
              </select>
            </Field>
            <Field label="Structure / variation theme" hint={`Detected: ${detected.theme}`}>
              <select value={p.theme ?? ''} onChange={(e) => save({ theme: e.target.value })}>
                <option value="">Auto ({detected.theme})</option><option value="SA">Stand-alone (single variant)</option><option value="size">Size</option><option value="color">Color</option><option value="size and color">Size and color</option>
              </select>
            </Field>
            {optionNames.length > 0 && (
              <div className="grid2" style={{ gap: 8 }}>
                <Field label="Size option"><select value={p.sizeOption ?? ''} onChange={(e) => save({ sizeOption: e.target.value })}><option value="">Auto ({detected.sizeOption ?? 'none'})</option>{optionNames.map((o) => <option key={o}>{o}</option>)}</select></Field>
                <Field label="Color option"><select value={p.colorOption ?? ''} onChange={(e) => save({ colorOption: e.target.value })}><option value="">Auto ({detected.colorOption ?? 'none'})</option>{optionNames.map((o) => <option key={o}>{o}</option>)}</select></Field>
              </div>
            )}
            {detected.theme !== 'SA' && (
              <Field label="Parent SKU (VAP external_id)" hint={p.targetParentId ? 'Locked: parent exists on Target' : 'Leave empty to use the pattern from Settings'}>
                <input defaultValue={p.parentExternalId ?? ''} disabled={!!p.targetParentId} placeholder={pv?.parent?.external_id} onBlur={(e) => e.target.value !== (p.parentExternalId ?? '') && save({ parentExternalId: e.target.value })} />
              </Field>
            )}
            {!onTarget && variants.length > 1 && <OnlySend variants={variants} sizeOpt={p.sizeOption || detected.sizeOption} colorOpt={p.colorOption || detected.colorOption} busy={busy} run={run} done={reloadAll} />}
            {p.itemTypeId && <Link className="small" to={`/taxonomy/${p.itemTypeId}`}>Edit attribute mapping for this item type →</Link>}
          </div>
        </Card>
        <Card title="On Target">
          <div className="kv">
            {detected.theme !== 'SA' && <><div>Parent</div><div>{p.targetParentId ? <><code>{p.parentExternalId}</code> · TCIN <code>{p.targetParentTcin}</code> <Status value={p.parentStatus} /></> : <span className="muted">not created</span>}</div></>}
            <div>Items on Target</div><div>{variants.filter((v: any) => v.targetProductId).length} of {variants.length}</div>
            <div>Last sent</div><div>{ago(p.lastPushedAt)}</div>
            {p.lastPushError && <><div>Last error</div><div className="bad small">{p.lastPushError}</div></>}
          </div>
          {lastResult?.results?.length > 0 && (
            <div className="small" style={{ marginTop: 10 }}>
              {lastResult.results.map((r: any, i: number) => <div key={i}><code>{r.sku}</code> {r.action}{r.tcin ? ` · TCIN ${r.tcin}` : ''}{r.reason ? <span className="bad"> · {r.reason}</span> : ''}</div>)}
            </div>
          )}
        </Card>
        <Card title="Validation" actions={<Btn size="sm" kind="ghost" onClick={preview.reload}>Recheck</Btn>}>
          {preview.loading && !pv ? <Loading /> : preview.error ? <div className="bad small">{preview.error}</div> : (
            <div className="stack">
              <div style={{ maxHeight: 260, overflow: 'auto' }}><Issues issues={pv.issues} /></div>
              {pv.issues.some((i: any) => i.level === 'error') && <Btn size="sm" kind="danger" busy={busy === 'push'} onClick={() => confirm('Send even though validation found errors? Target will likely reject these items.') && push(true)}>Send anyway</Btn>}
            </div>
          )}
        </Card>
      </div>

      <Tabs value={tab} onChange={setTab} items={[['mapping', 'Shopify → Target mapping'], ['items', `Items (${variants.length})`], ['content', 'Content & overrides'], ['json', 'Target JSON'], ['logistics', 'Logistics']]} />

      {tab === 'mapping' && <MappingView key={p.updatedAt} productId={id!} itemTypeId={p.itemTypeId} />}

      {tab === 'items' && (
        <Card pad={false}>
          <div className="table-wrap"><table>
            <thead><tr><th>SKU</th><th>Options</th><th>Barcode</th><th className="num">Shopify price</th><th>Target price</th><th>Stock → DC</th><th>Target</th><th /></tr></thead>
            <tbody>
              {variants.map((v: any) => (
                <tr key={v.id}>
                  <td><code>{v.sku || '—'}</code>{!v.syncEnabled && <div className="small warn">excluded</div>}</td>
                  <td className="small">{Object.entries(v.options).map(([k, x]) => `${k}: ${x}`).join(' · ') || '—'}</td>
                  <td className="small">
                    <div><code>{v.barcode || '—'}</code> <span className={v.barcodeCheck.level === 'ok' ? 'ok' : v.barcodeCheck.level === 'warning' || v.mockBarcode ? 'warn' : 'bad'}>{v.barcodeCheck.level === 'ok' ? '✓' : v.barcodeCheck.message}{v.mockBarcode && v.barcodeCheck.level !== 'ok' ? ' (needed for production)' : ''}</span></div>
                    {v.mockBarcode && <div className="muted">stage test: <code>{v.mockBarcode}</code> <button className="btn ghost sm" onClick={() => run('mb', () => patch(`/api/variants/${v.id}`, { regenerateMockBarcode: true }), 'New test barcode').then(reloadAll)}>new</button></div>}
                  </td>
                  <td className="num small">{money(v.price)}{v.compareAtPrice && <div className="muted"><s>{money(v.compareAtPrice)}</s></div>}</td>
                  <td className="small">{v.targetPrice ? <>list {money(v.targetPrice.list_price)}{v.targetPrice.offer_price && <> · offer {money(v.targetPrice.offer_price)}</>}</> : '—'}{v.priceIssues?.length > 0 && <div className="bad">{v.priceIssues.join('; ')}</div>}{v.lastPriceSent && <div className="muted">sent {ago(v.lastPriceSentAt)}</div>}</td>
                  <td className="small">{v.targetQty ? Object.entries(v.targetQty).map(([dc, q]) => <div key={dc}>{q as number} → {dc}{v.lastQtySent?.[dc] !== undefined && v.lastQtySent[dc] !== q && <span className="warn"> (Target has {v.lastQtySent[dc]})</span>}</div>) : <span className="muted">no DCs</span>}</td>
                  <td className="small">
                    {v.targetProductId ? <><div>TCIN <code>{v.tcin}</code> <Copy text={v.tcin ?? ''} /></div><div className="row" style={{ gap: 4 }}><Status value={v.listingStatus} /><Status value={v.validationStatus} /></div>
                      {Array.isArray(v.errors) && v.errors.map((e: any, i: number) => <div key={i} className="bad">{e.reason}{e.field_name ? ` (${e.field_name})` : ''}</div>)}</> : <span className="muted">not sent</span>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      {v.targetProductId && <button className="btn sm" onClick={async () => setLive(await get(`/api/variants/${v.id}/target`))}>View on Target</button>}
                      {v.targetProductId && v.listingStatus === 'APPROVED' && <button className="btn sm" onClick={() => confirm(`Unlist ${v.sku} from Target?`) && run('unlist', () => post(`/api/variants/${v.id}/unlist`), 'Unlisted').then(reloadAll)}>Unlist</button>}
                      <button className="btn ghost sm" onClick={() => run('ex', () => patch(`/api/variants/${v.id}`, { syncEnabled: !v.syncEnabled }), v.syncEnabled ? 'Excluded from Target' : 'Included').then(reloadAll)}>{v.syncEnabled ? 'Exclude' : 'Include'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      {tab === 'content' && (
        <div className="grid2">
          <Card title="Feature bullets" actions={<Btn size="sm" kind="primary" onClick={() => save({ bullets: bullets.split('\n') }, 'Bullets saved')}>Save</Btn>}>
            <div className="stack small">
              <textarea rows={8} value={bullets} onChange={(e) => setBullets(e.target.value)} placeholder="One bullet per line (2-15 bullets, 3-8 words each, max 120 characters)" />
              <span className="muted">{bullets.split('\n').filter((x) => x.trim()).length} bullets. Taken from the &lt;li&gt; items in the Shopify description on first import.</span>
            </div>
          </Card>
          <Card title="Attribute overrides (this product only)">
            <p className="small muted" style={{ marginTop: 0 }}>Values here win over the item type mapping, for every item in this product. Use the attribute key shown in the Target JSON (e.g. <code>107707</code>, <code>descriptions.parent_title</code>).</p>
            <Overrides value={p.overrides} keys={keys} onSave={(o) => save({ overrides: o }, 'Overrides saved')} />
          </Card>
          <Card title="Shopify description">
            <div className="small" style={{ maxHeight: 300, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: (p.descriptionHtml ?? '').replace(/<script[\s\S]*?<\/script>/gi, '') }} />
          </Card>
          <Card title="Images">
            <div className="row">{(p.images ?? []).map((u: string) => <img key={u} src={u} alt="" style={{ width: 90, height: 90, objectFit: 'cover', border: '1px solid var(--line)', borderRadius: 4 }} />)}</div>
            <div className="small muted" style={{ marginTop: 8 }}>Target needs 1 primary + at least 2 alternate images, ideally 2400×2400 px on white or gray.</div>
          </Card>
        </div>
      )}

      {tab === 'json' && pv && (
        <div className="stack">
          {pv.parent && <Card title={`Parent (VAP) · ${pv.parent.external_id}`} actions={<Copy text={JSON.stringify(pv.parent, null, 2)} />}><Json value={pv.parent} /></Card>}
          {pv.items.map((it: any) => <Card key={it.sku} title={`${it.payload.relationship_type} · ${it.sku}`} actions={<Copy text={JSON.stringify(it.payload, null, 2)} />}><Json value={it.payload} /></Card>)}
        </div>
      )}

      {tab === 'logistics' && (
        <Card title="Logistics (sent separately, after the item is created)">
          <div className="stack" style={{ maxWidth: 520 }}>
            <p className="small muted" style={{ margin: 0 }}>All 4 fields are sent together. Never sent for the parent. Empty = defaults from Settings › Sync & rules.</p>
            {[['is_add_on', 'Add-on item'], ['two_day_shipping_eligible', 'Two-day shipping eligible'], ['shipping_exclusion', 'Shipping exclusion']].map(([k, label]) => (
              <Field key={k} label={label}>
                <select value={p.logistics?.[k] ?? ''} onChange={(e) => save({ logistics: { ...(p.logistics ?? {}), [k]: e.target.value || undefined } })}>
                  <option value="">Default</option><option>Yes</option><option>No</option>
                </select>
              </Field>
            ))}
            <Field label="Return policy ID"><input defaultValue={p.logistics?.seller_return_policy ?? ''} placeholder="Default" onBlur={(e) => save({ logistics: { ...(p.logistics ?? {}), seller_return_policy: e.target.value.toUpperCase() || undefined } })} /></Field>
            <div><Btn kind="primary" disabled={!onTarget} busy={busy === 'log'} onClick={() => run('log', () => post(`/api/products/${id}/logistics`), (r: any) => `Logistics queued for ${r.queued} item(s)`)}>Send logistics to Target</Btn></div>
          </div>
        </Card>
      )}

      {!onTarget && (
        <div style={{ marginTop: 24 }}><Btn kind="ghost" size="sm" onClick={() => confirm('Remove this product from the hub? (Shopify is not touched.)') && run('del', () => del(`/api/products/${id}`), 'Removed').then(() => nav('/products'))}>Remove from hub</Btn></div>
      )}

      {live && <Modal title="What Target has" wide onClose={() => setLive(null)}>
        <div className="grid2">
          <Card title="Price"><Json value={live.price} /></Card>
          <Card title="Quantities"><Json value={live.quantities} /></Card>
          <Card title="Logistics"><Json value={live.logistics} /></Card>
          <Card title="Product"><Json value={live.product} /></Card>
        </div>
      </Modal>}
    </div>
  );
}

/** Pick which SKUs go to Target before the first send (e.g. one color for a size-only family). */
function OnlySend({ variants, sizeOpt, colorOpt, busy, run, done }: any) {
  const vals = (opt: string | null) => (opt ? [...new Set(variants.map((v: any) => v.options?.[opt]).filter(Boolean))] as string[] : []);
  const colors = vals(colorOpt), sizes = vals(sizeOpt);
  const [color, setColor] = useState('');
  const [size, setSize] = useState('');
  const [skuOne, setSkuOne] = useState('');
  const included = variants.filter((v: any) => v.syncEnabled).length;
  const apply = (keep: (v: any) => boolean, label: string) => run('only', async () => {
    let n = 0;
    for (const v of variants) {
      const want = keep(v);
      if (!!v.syncEnabled !== want) await patch(`/api/variants/${v.id}`, { syncEnabled: want });
      if (want) n++;
    }
    return n;
  }, (n: any) => `${label}: ${n} SKU(s) will be sent, the rest are excluded`).then(done);
  const match = (v: any) => (!color || v.options?.[colorOpt] === color) && (!size || v.options?.[sizeOpt] === size);
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 10 }}>
      <div className="small"><strong>Which SKUs to send</strong> <span className="muted">· {included} of {variants.length} included</span></div>
      <div className="grid2" style={{ gap: 8 }}>
        {colors.length > 0 && <Field label="Only this color"><select value={color} onChange={(e) => setColor(e.target.value)}><option value="">All colors</option>{colors.map((c) => <option key={c}>{c}</option>)}</select></Field>}
        {sizes.length > 0 && <Field label="Only this size"><select value={size} onChange={(e) => setSize(e.target.value)}><option value="">All sizes</option>{sizes.map((c) => <option key={c}>{c}</option>)}</select></Field>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Btn size="sm" busy={busy === 'only'} onClick={() => apply(match, 'Applied')}>Apply</Btn>
        <Btn size="sm" kind="ghost" busy={busy === 'only'} onClick={() => apply(() => true, 'All included')}>Include all</Btn>
      </div>
      <Field label="Or send just one SKU (stand-alone test)">
        <div className="row" style={{ gap: 6 }}>
          <select value={skuOne} onChange={(e) => setSkuOne(e.target.value)}><option value="">— pick a SKU —</option>{variants.map((v: any) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select>
          <Btn size="sm" disabled={!skuOne} busy={busy === 'only'} onClick={() => apply((v: any) => v.id === skuOne, 'One SKU')}>Keep only this</Btn>
        </div>
      </Field>
    </div>
  );
}

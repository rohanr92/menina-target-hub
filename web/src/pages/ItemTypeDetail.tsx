import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, put } from '../lib/api';
import { Btn, Card, ErrorBox, Loading, PageHead, Tabs, useAction, useLoad } from '../components/ui';

type Rule = { key: string; source: 'auto' | 'field' | 'template' | 'constant' | 'skip'; value?: string; valueMap?: Record<string, string> };

const CORE_AUTO: Record<string, string> = {
  'brands.name': 'Shopify vendor (Valor Fitness on stage)',
  'descriptions.title': 'Product title + color/size for children',
  'descriptions.parent_title': 'Product title',
  'descriptions.long_description': 'Shopify description, HTML removed, bullet list removed',
  'barcode.value': 'Variant barcode (generated test UPC on stage)',
  'digital_assets.images.primary_image_url': 'Variant image, else first product image',
  'digital_assets.images.parent_image_url': 'First product image',
  'package_dimensions.measurements.weight': 'Variant weight in lb',
  'child_variations.size': 'Size option',
  'child_variations.color': 'Color option',
  'variation.theme': 'Detected from options',
  'compliance.import_designation': '“imported”',
  'compliance.is_proposition_65': '“No”',
  'compliance.tax_category.tax_code': '“Shoes” for footwear, else “General Clothing”',
};
const autoText = (key: string) =>
  CORE_AUTO[key] ?? (/^descriptions\.bullets\[(\d+)\]$/.test(key) ? `Bullet ${key.match(/\d+/)![0]} from the product`
    : /alternate_image_urls\[(\d+)\]/.test(key) ? `Product image #${Number(key.match(/\[(\d+)\]/)![1]) + 1}` : null);

function AllowedValues({ attrId, value, onChange, placeholder }: { attrId: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [vals, setVals] = useState<string[] | null>(null);
  useEffect(() => { get(`/api/taxonomy/attributes/${attrId}/values`).then((r) => setVals(r.map((x: any) => x.name))).catch(() => setVals([])); }, [attrId]);
  if (!vals) return <input disabled placeholder="loading values…" />;
  if (!vals.length) return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'value'} />;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? '— choose —'}</option>
      {vals.map((v) => <option key={v} value={v}>{v}</option>)}
    </select>
  );
}

function MappingEditor({ itemTypeId }: { itemTypeId: string }) {
  const m = useLoad(() => get(`/api/mapping/${itemTypeId}`), [itemTypeId]);
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [filter, setFilter] = useState<'all' | 'required' | 'missing'>('required');
  const { busy, run } = useAction();
  useEffect(() => { if (m.data) setRules(Object.fromEntries(m.data.rules.map((r: Rule) => [r.key, r]))); }, [m.data]);
  const fieldOptions = useMemo(() => {
    if (!m.data) return [];
    const base = ['product.title', 'product.vendor', 'product.productType', 'product.handle', 'product.description', 'variant.sku', 'variant.barcode', 'variant.weightLb', 'variant.size', 'variant.color', 'variant.title', 'variant.price'];
    return [...base, ...m.data.productOptions.map((o: string) => `option:${o}`), ...[1, 2, 3, 4, 5].map((n) => `image:${n}`), ...[1, 2, 3, 4, 5].map((n) => `bullet:${n}`)];
  }, [m.data]);
  if (m.loading && !m.data) return <Loading />;
  if (m.error) return <ErrorBox error={m.error} />;
  const attrs = m.data.attributes as any[];
  const coreExtra = ['descriptions.parent_title', 'variation.theme', 'child_variations.size', 'child_variations.color', 'digital_assets.images.parent_image_url']
    .filter((k) => !attrs.some((a) => a.key === k)).map((k) => ({ id: null, key: k, name: k, type: 'TEXT', group: 'CORE', required: false }));
  const all = [...attrs, ...coreExtra];
  const ruleOf = (k: string): Rule => rules[k] ?? { key: k, source: 'auto' };
  const setRule = (k: string, patch: Partial<Rule>) => setRules((r) => ({ ...r, [k]: { ...ruleOf(k), ...patch } }));
  const covered = (a: any) => { const r = ruleOf(a.key); return r.source !== 'auto' ? r.source !== 'skip' : !!autoText(a.key); };
  const shown = all.filter((a) => filter === 'all' || (filter === 'required' ? a.required : !covered(a) && a.required));

  const sourceValues = (r: Rule): string[] => {
    if (r.source !== 'field' || !r.value) return [];
    const ov = m.data.optionValues as Record<string, string[]>;
    if (r.value.startsWith('option:')) return ov[r.value.slice(7)] ?? [];
    if (r.value === 'variant.color') return Object.entries(ov).filter(([k]) => /colou?r/i.test(k)).flatMap(([, v]) => v);
    if (r.value === 'variant.size') return Object.entries(ov).filter(([k]) => /size|talla/i.test(k)).flatMap(([, v]) => v);
    if (r.value.startsWith('tag:')) { const p = r.value.slice(4).toLowerCase(); return (m.data.tags as string[]).filter((t) => t.toLowerCase().startsWith(p)).map((t) => t.slice(p.length).replace(/^[\s:=_-]+/, '').trim()); }
    return Object.keys(r.valueMap ?? {});
  };

  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <Tabs value={filter} onChange={setFilter} items={[['required', 'Required'], ['missing', 'Required & not covered'], ['all', `All (${all.length})`]]} />
        </div>
        <Btn kind="primary" busy={busy === 'save'} onClick={() => run('save', () => put(`/api/mapping/${itemTypeId}`, { rules: Object.values(rules) }), 'Mapping saved').then(m.reload)}>Save mapping</Btn>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        <strong>Auto</strong> uses the built-in rule. <strong>Field</strong> reads a Shopify field, option or tag (tag:Material reads “Material: Leather”). <strong>Template</strong> builds text from {'{title} {brand} {vendor} {color} {size} {sku} {productType}'}. <strong>Constant</strong> sends the same value for every item (e.g. package dimensions of your shoe box). Per-product overrides are on each product page.
      </p>
      <div className="card"><div className="table-wrap">
        <table>
          <thead><tr><th style={{ width: '26%' }}>Target attribute</th><th style={{ width: 120 }}>Source</th><th>Value</th></tr></thead>
          <tbody>
            {shown.map((a) => {
              const r = ruleOf(a.key);
              const vals = a.type === 'VALUE' ? sourceValues(r) : [];
              return (
                <tr key={a.key}>
                  <td>
                    <div><strong>{a.name}</strong> {a.required && <span className="badge solid">required</span>}</div>
                    <div className="small muted"><code>{a.key}</code> · {a.type}{a.maxSelections > 1 ? ` · up to ${a.maxSelections} (separate with |)` : ''} · {a.group}</div>
                  </td>
                  <td>
                    <select value={r.source} onChange={(e) => setRule(a.key, { source: e.target.value as any, value: '' })}>
                      <option value="auto">Auto</option><option value="field">Field</option><option value="template">Template</option><option value="constant">Constant</option><option value="skip">Don’t send</option>
                    </select>
                  </td>
                  <td>
                    {r.source === 'auto' && <span className={autoText(a.key) ? 'small' : 'small warn'}>{autoText(a.key) ?? (a.required ? 'No automatic value. Choose a source.' : 'Not sent')}</span>}
                    {r.source === 'skip' && <span className="small muted">Not sent</span>}
                    {r.source === 'template' && <input value={r.value ?? ''} onChange={(e) => setRule(a.key, { value: e.target.value })} placeholder="{brand} Women's {title} - {color} {size}" />}
                    {r.source === 'constant' && (a.type === 'VALUE' && a.id
                      ? <AllowedValues attrId={a.id} value={r.value ?? ''} onChange={(v) => setRule(a.key, { value: v })} />
                      : <input value={r.value ?? ''} onChange={(e) => setRule(a.key, { value: e.target.value })} placeholder={a.type === 'MEASURE' ? 'number (inches / pounds)' : 'value'} />)}
                    {r.source === 'field' && (
                      <div className="stack">
                        <div className="row">
                          <select style={{ width: 220 }} value={r.value?.startsWith('tag:') ? 'tag:' : r.value ?? ''} onChange={(e) => setRule(a.key, { value: e.target.value === 'tag:' ? 'tag:' : e.target.value })}>
                            <option value="">— choose field —</option>
                            {fieldOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                            <option value="tag:">tag:&lt;prefix&gt;</option>
                          </select>
                          {r.value?.startsWith('tag:') && <input style={{ width: 160 }} placeholder="Tag prefix e.g. Material" value={r.value.slice(4)} onChange={(e) => setRule(a.key, { value: `tag:${e.target.value}` })} />}
                        </div>
                        {a.type === 'VALUE' && a.id && r.value && (
                          <div className="stack small">
                            <span className="muted">Translate your values to Target’s list (unmapped values are matched by name):</span>
                            {[...new Set([...vals, ...Object.keys(r.valueMap ?? {})])].map((v) => (
                              <div key={v} className="row">
                                <span style={{ width: 140 }}>{v}</span><span>→</span>
                                <div style={{ width: 240 }}><AllowedValues attrId={a.id} value={r.valueMap?.[v] ?? ''} placeholder="same name" onChange={(t) => setRule(a.key, { valueMap: { ...(r.valueMap ?? {}), [v]: t } })} /></div>
                              </div>
                            ))}
                            <button className="btn ghost sm" style={{ width: 'fit-content' }} onClick={() => { const v = prompt('Your value (as in Shopify)'); if (v) setRule(a.key, { valueMap: { ...(r.valueMap ?? {}), [v]: '' } }); }}>Add value</button>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={3} className="empty">Nothing here. {filter === 'missing' ? 'All required attributes are covered.' : ''}</td></tr>}
          </tbody>
        </table>
      </div></div>
    </div>
  );
}

export default function ItemTypeDetail() {
  const { id } = useParams();
  const d = useLoad(() => get(`/api/taxonomy/item-types/${id}`), [id]);
  const [tab, setTab] = useState<'attributes' | 'mapping'>('attributes');
  const [values, setValues] = useState<{ attr: any; list: any[] } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!d.data?.valuesProgress) return;
    const t = setTimeout(d.reload, 2500);
    return () => clearTimeout(t);
  }, [d.data]);
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (d.error) return <div className="page"><ErrorBox error={d.error} /></div>;
  const { itemType, summary, attributes, valuesProgress } = d.data;
  return (
    <div className="page">
      <PageHead title={itemType.name} sub={<><Link to="/taxonomy">Taxonomy</Link> · item type <code>{itemType.id}</code></>}>
        <Btn busy={busy === 'attrs'} onClick={() => run('attrs', () => post(`/api/taxonomy/item-types/${id}/attributes`), (r: any) => `${r.attributes} attributes`).then(d.reload)}>Pull attributes</Btn>
        <Btn busy={!!valuesProgress || busy === 'vals'} disabled={!attributes.length} onClick={() => run('vals', () => post(`/api/taxonomy/item-types/${id}/values`, {}), 'Pulling value lists in the background').then(d.reload)}>
          {valuesProgress ? `Values ${valuesProgress.done}/${valuesProgress.total}` : 'Pull value lists'}
        </Btn>
      </PageHead>
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Total attributes</div><div className="value">{summary.total}</div><div className="sub">test plan 4.2</div></div>
        <div className="stat"><div className="label">Required</div><div className="value">{summary.required}</div><div className="sub">test plan 4.3 · optional {summary.optional} (4.4)</div></div>
        <div className="stat"><div className="label">Attribute types</div><div className="value" style={{ fontSize: 15, marginTop: 10 }}>{Object.entries(summary.byType).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</div><div className="sub">test plan 4.5</div></div>
        <div className="stat"><div className="label">Feature bullets allowed</div><div className="value">{summary.bullets || '—'}</div><div className="sub">test plan 5.1</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} items={[['attributes', 'Attributes'], ['mapping', 'Mapping']]} />
      {tab === 'attributes' && (
        <Card pad={false}>
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Send as (name)</th><th>Type</th><th>Group</th><th>Required</th><th className="num">Max</th><th className="num">Values</th></tr></thead>
            <tbody>
              {attributes.length === 0 && <tr><td colSpan={7} className="empty">Click “Pull attributes”.</td></tr>}
              {attributes.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.name}<div className="small muted">{a.description}</div></td>
                  <td><code>{a.key}</code></td><td>{a.type}</td><td>{a.group}</td><td>{a.required ? <span className="badge solid">required</span> : <span className="muted">optional</span>}</td>
                  <td className="num">{a.maxSelections}</td>
                  <td className="num">{['VALUE', 'MEASURE'].includes(a.type) ? <button className="btn ghost sm" onClick={async () => setValues({ attr: a, list: await get(`/api/taxonomy/attributes/${a.id}/values`) })}>{a.valuesFetched ? a.valueCount : '…'}</button> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
      {tab === 'mapping' && <MappingEditor itemTypeId={id!} />}
      {values && (
        <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && setValues(null)}>
          <div className="modal"><div className="card-h"><h2 style={{ margin: 0 }}>{values.attr.name} · {values.list.length} values</h2><button className="btn ghost sm" onClick={() => setValues(null)}>Close</button></div>
            <div className="card-b small" style={{ columns: 3 }}>{values.list.map((v) => <div key={v.id}>{v.name}</div>)}</div></div>
        </div>
      )}
    </div>
  );
}

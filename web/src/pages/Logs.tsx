import { useState } from 'react';
import { get } from '../lib/api';
import { dt } from '../lib/format';
import { Btn, Card, Copy, Json, Loading, Modal, PageHead, useLoad } from '../components/ui';

export default function Logs() {
  const [service, setService] = useState('');
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const list = useLoad(() => get(`/api/logs?service=${service}&failed=${failed ? 1 : ''}&q=${encodeURIComponent(q)}&page=${page}`), [service, failed, q, page]);
  const tryJson = (s?: string) => { if (!s) return ''; try { return JSON.parse(s); } catch { return s; } };
  return (
    <div className="page">
      <PageHead title="API log" sub="Every call to Target and Shopify, with request and response (API keys and tokens are never logged). Handy for the Slack channel when you need help from the Target team. Kept for 30 days.">
        <Btn kind="ghost" onClick={list.reload}>Refresh</Btn>
      </PageHead>
      <div className="row" style={{ marginBottom: 12 }}>
        <select style={{ width: 140 }} value={service} onChange={(e) => { setService(e.target.value); setPage(1); }}><option value="">All services</option><option value="target">Target</option><option value="shopify">Shopify</option></select>
        <label className="inline-check"><input type="checkbox" checked={failed} onChange={(e) => { setFailed(e.target.checked); setPage(1); }} />Errors only</label>
        <input style={{ width: 280 }} placeholder="Search URL or body (SKU, order id…)" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Time</th><th>Service</th><th>Method</th><th>URL</th><th className="num">Status</th><th className="num">ms</th><th>Source</th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={7} className="empty">No calls logged.</td></tr>}
              {list.data.map((l: any) => (
                <tr key={l.id} className="click" onClick={async () => setOpen(await get(`/api/logs/${l.id}`))}>
                  <td className="small">{dt(l.createdAt)}</td><td>{l.service}{l.env ? <span className="muted"> · {l.env}</span> : ''}</td><td>{l.method}</td>
                  <td className="small mono" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.url.replace(/^https?:\/\/[^/]+/, '')}</td>
                  <td className={`num ${!l.status || l.status >= 400 ? 'bad' : ''}`}>{l.status ?? 'ERR'}</td><td className="num muted">{l.durationMs}</td><td className="small muted">{l.source}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <div className="row" style={{ marginTop: 10 }}>
        <Btn size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Btn>
        <Btn size="sm" disabled={(list.data?.length ?? 0) < 50} onClick={() => setPage(page + 1)}>Older</Btn>
      </div>
      {open && (
        <Modal title={`${open.method} · HTTP ${open.status ?? 'error'}`} wide onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="row"><code style={{ wordBreak: 'break-all' }}>{open.url}</code><Copy text={open.url} /></div>
            {open.error && <div className="bad">{open.error}</div>}
            <div className="grid2">
              <div><h3>Request body</h3><Json value={tryJson(open.requestBody) || '—'} /></div>
              <div><h3>Response</h3><Json value={tryJson(open.responseBody) || '—'} /></div>
            </div>
            <div><Copy text={`${open.method} ${open.url}\nHTTP ${open.status}\n\nRequest:\n${open.requestBody ?? ''}\n\nResponse:\n${open.responseBody ?? ''}`} /> <span className="small muted">copy for Slack</span></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

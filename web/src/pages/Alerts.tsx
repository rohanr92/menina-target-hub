import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { Btn, Card, Loading, PageHead, useAction, useLoad } from '../components/ui';

export default function Alerts() {
  const [all, setAll] = useState(false);
  const d = useLoad(() => get(`/api/alerts${all ? '?all=1' : ''}`).then(async (r) => { await post('/api/alerts/seen').catch(() => {}); return r; }), [all]);
  const { busy, run } = useAction();
  const list: any[] = d.data?.alerts ?? [];
  return (
    <div className="page">
      <PageHead title="Alerts" sub="Late or soon-due orders, orders that could not be created in Shopify, shipment / tracking problems, held price drops and connection problems. Each alert also goes to Slack when it is connected (Settings › Team & alerts).">
        <Btn kind="ghost" onClick={() => setAll(!all)}>{all ? 'Show open only' : 'Show history'}</Btn>
        {list.some((a) => !a.resolved) && <Btn busy={busy === 'all'} onClick={() => confirm('Mark every open alert as done?') && run('all', () => post('/api/alerts/resolve-all'), 'All alerts marked done').then(d.reload)}>Mark all done</Btn>}
      </PageHead>
      <Card pad={false}>
        {d.loading && !d.data ? <Loading /> : list.length === 0 ? <div className="empty">🎉 Nothing needs your attention.</div> : (
          <div>
            {list.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 18px', borderTop: '1px solid #f1f3f6', opacity: a.resolved ? 0.55 : 1 }}>
                <span className={`sev ${a.severity}`} style={{ marginTop: 6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{a.link ? <Link to={a.link}>{a.title}</Link> : a.title}</div>
                  {a.detail && <div className="small muted" style={{ marginTop: 2, wordBreak: 'break-word' }}>{a.detail}</div>}
                  <div className="small muted" style={{ marginTop: 4 }}>{ago(a.at)} · {a.kind.replace(/-/g, ' ')}{a.resolved ? ' · done' : ''}</div>
                </div>
                {!a.resolved && <Btn size="sm" kind="ghost" onClick={() => run('r' + a.id, () => post(`/api/alerts/${a.id}/resolve`), 'Marked done').then(d.reload)}>Done</Btn>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

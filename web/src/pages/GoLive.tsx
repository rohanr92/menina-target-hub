import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { Btn, Card, Loading, PageHead, useAction, useLoad } from '../components/ui';

const Row = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <div className={ok ? 'ok' : 'warn'} style={{ padding: '4px 0' }}>{ok ? '✓' : '•'} {children}</div>
);

export default function GoLive() {
  const d = useLoad(() => get('/api/golive/status'), []);
  const { busy, run } = useAction();
  const [typed, setTyped] = useState('');
  const s: any = d.data;
  if (!s) return <div className="page"><PageHead title="Go live" /><Card><Loading /></Card></div>;
  const sd = s.stageData;
  const clean = !sd.linkedSkus && !sd.parents && !sd.fixedStock && !sd.fixedPrice && !sd.stageOrders;
  const anySync = Object.values(s.syncOn).some(Boolean);
  return (
    <div className="page">
      <PageHead title="Go live" sub="Move the hub from Stage (test) to Production (your live Target store) safely, one step at a time." />
      <Card title="Step 1 · Production connection">
        <Row ok={s.productionReady}>{s.productionReady ? 'Production keys saved and OAuth connected' : <>Not ready: add the production keys in <Link to="/settings">Settings › Target · Production</Link> and click “Connect with Target”</>}</Row>
      </Card>
      <Card title="Step 2 · Clear the Stage test data (and pause sync)">
        <div className="small stack">
          <div>Still linked to Stage: <b>{sd.linkedSkus}</b> SKUs · <b>{sd.parents}</b> parents · <b>{sd.fixedStock}</b> fixed test stock · <b>{sd.fixedPrice}</b> test prices · <b>{sd.stageOrders}</b> test orders · <b>{sd.queuedTasks}</b> queued pushes</div>
          <div className="muted">Clears only the Stage links (Target ids, TCINs, test stock, test prices, test orders) and turns OFF: pull orders, auto acknowledge, inventory sync, price sync. Your Shopify products, item types and content edits stay.</div>
          {s.activeEnv !== 'stage' && <div className="bad">The hub is on Production. Switch back to Stage (top right) to run this step.</div>}
          {clean && !anySync ? <Row ok>Stage data cleared and sync paused</Row> : (
            <div className="row">
              <input placeholder="type CLEAR" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 140 }} />
              <Btn kind="danger" disabled={typed !== 'CLEAR' || s.activeEnv !== 'stage'} busy={busy === 'clear'}
                onClick={() => run('clear', () => post('/api/golive/clear-stage', { confirm: 'CLEAR' }), (r: any) => `Cleared ${r.variants} SKUs, ${r.products} products, ${r.orders} test orders. Sync paused.`).then(d.reload)}>Clear Stage data</Btn>
            </div>
          )}
        </div>
      </Card>
      <Card title="Step 3 · Switch to Production">
        <div className="small stack">
          <Row ok={s.activeEnv === 'production'}>{s.activeEnv === 'production' ? 'The hub is on Production' : 'Click “Production” at the top right (only after step 2)'}</Row>
          <div className="muted">Sync stays paused, so switching sends nothing to Target.</div>
        </div>
      </Card>
      <Card title="Step 4 · Bring in your live Target items">
        <div className="small">Open <Link to="/target-catalog">Target catalog</Link> → “1 · Fetch from Target”. This only reads. Linking comes later, after the old Shopify app is disconnected.</div>
      </Card>
      <Card title="Sync right now">
        <div className="small">
          {Object.entries(s.syncOn).map(([k, v]) => <div key={k} className={v ? 'warn' : 'muted'}>{v ? 'ON' : 'off'} · {k}</div>)}
        </div>
      </Card>
    </div>
  );
}

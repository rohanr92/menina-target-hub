import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { get, post, put, setUnauthorizedHandler } from './lib/api';
import { Btn, useToast } from './components/ui';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import GoLive from './pages/GoLive';
import Alerts from './pages/Alerts';
import Activity from './pages/Activity';
import Taxonomy from './pages/Taxonomy';
import ItemTypeDetail from './pages/ItemTypeDetail';
import Products from './pages/Products';
import BulkEdit from './pages/BulkEdit';
import ProductDetail from './pages/ProductDetail';
import Inventory from './pages/Inventory';
import TargetCatalog from './pages/TargetCatalog';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Reports from './pages/Reports';
import Returns from './pages/Returns';
import ListingErrors from './pages/ListingErrors';
import TestPlan from './pages/TestPlan';
import Console from './pages/Console';
import Logs from './pages/Logs';

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="box" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await post('/api/auth/login', email.trim() ? { email: email.trim(), password: pw } : { password: pw }); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
      }}>
        <div className="brand" style={{ padding: 0 }}><span className="mark" /><div>Target Hub<small>Menina Step · Target Plus</small></div></div>
        <input type="email" placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
        <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        <div className="small muted">No personal login yet? Leave the email empty and use the team password.</div>
        {err && <div className="bad small">{err}</div>}
        <Btn kind="primary" busy={busy} type="submit">Sign in</Btn>
      </form>
    </div>
  );
}

function EnvSwitch() {
  const [env, setEnv] = useState<string>('stage');
  const toast = useToast();
  useEffect(() => { get('/api/settings').then((s) => setEnv(s.activeEnv)).catch(() => {}); }, []);
  const change = async (e: string) => {
    if (e === env) return;
    if (e === 'production' && !confirm('Switch to PRODUCTION? Every action will affect your live Target listings and orders.')) return;
    await put('/api/settings/active-env', { env: e });
    setEnv(e); toast(`Now using ${e}`);
    setTimeout(() => location.reload(), 300);
  };
  return (
    <div className="env-switch">
      <button className={env === 'stage' ? 'on' : ''} onClick={() => change('stage')}>Stage</button>
      <button className={env === 'production' ? 'on' : ''} onClick={() => change('production')}>Production</button>
    </div>
  );
}

/** Open-order count in the menu; new (unacknowledged) orders show in red and raise a browser alert. */
function OrdersBadge() {
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    let last = -1;
    const tick = () => get('/api/orders/counts').then((x: any) => {
      setC(x);
      if (last >= 0 && x.released > last) {
        try { if ('Notification' in window && Notification.permission === 'granted') new Notification('New Target order', { body: `${x.released} order(s) waiting for acknowledgement` }); } catch { /* ignore */ }
      }
      last = x.released;
      document.title = x.released ? `(${x.released}) Target Hub` : 'Target Hub';
    }).catch(() => {});
    tick();
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    const t = setInterval(tick, 60000);
    return () => clearInterval(t);
  }, []);
  if (!c?.open) return null;
  return <span className={`nav-badge ${c.released || c.late ? 'hot' : ''}`} title={`${c.open} open · ${c.released} new · ${c.late} late`}>{c.released ? `${c.released} new` : c.open}</span>;
}

/** Bell with open alerts (late orders, held prices, connection problems). Polls every minute. */
function AlertsBell() {
  const [a, setA] = useState<any>(null);
  useEffect(() => {
    const tick = () => get('/api/alerts').then(setA).catch(() => {});
    tick(); const t = setInterval(tick, 60000); return () => clearInterval(t);
  }, []);
  const n = a?.open ?? 0;
  return (
    <Link to="/alerts" className="bell" title={n ? `${n} open alert(s)` : 'No alerts'}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
      {n > 0 && <span className={a?.critical ? 'crit' : ''}>{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}

function StageBanner() {
  const [env, setEnv] = useState<string | null>(null);
  useEffect(() => { get('/api/settings').then((s) => setEnv(s.activeEnv)).catch(() => {}); }, []);
  if (env !== 'stage') return null;
  return <div className="stage-banner"><strong>STAGE</strong><span>Testing environment. Brand is forced to “Valor Fitness” and test barcodes are generated (Target’s stage rules).</span></div>;
}

const NAV: [string, [string, string][]][] = [
  ['Overview', [['/', 'Dashboard'], ['/test-plan', 'Test plan']]],
  ['Catalog', [['/products', 'Products'], ['/bulk', 'Bulk mapping'], ['/target-catalog', 'Target catalog'], ['/taxonomy', 'Taxonomy & mapping'], ['/inventory', 'Price & inventory'], ['/listing-errors', 'Listing errors']]],
  ['Orders', [['/orders', 'Orders'], ['/returns', 'Returns']]],
  ['Tools', [['/alerts', 'Alerts'], ['/activity', 'Activity'], ['/reports', 'Reports'], ['/console', 'API console'], ['/logs', 'API log'], ['/settings', 'Settings'], ['/go-live', 'Go live']]],
];

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    get('/api/auth/me').then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);
  const [env, setEnv] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => { if (authed) { get('/api/settings').then((s) => setEnv(s.activeEnv)).catch(() => {}); get('/api/auth/me').then((r) => setMe(r.user)).catch(() => {}); } }, [authed]);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  // testing pages are only shown while on Stage
  const nav = NAV.map(([g, links]) => [g, links.filter(([to]) => env === 'stage' || !['/test-plan', '/go-live'].includes(to))] as [string, [string, string][]]);
  return (
    <BrowserRouter>
      <div className={`shell ${menu ? 'menu-open' : ''}`}>
        <div className="topbar-m">
          <button className="hamburger" aria-label="Menu" onClick={() => setMenu(!menu)}><span /><span /><span /></button>
          <div className="brand" style={{ padding: 0 }}><span className="mark" /><div>Target Hub</div></div>
          <span style={{ flex: 1 }} />
          <AlertsBell />
        </div>
        {menu && <div className="scrim" onClick={() => setMenu(false)} />}
        <aside className="side" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setMenu(false); }}>
          <div className="brand"><span className="mark" /><div>Target Hub<small>Menina Step</small></div></div>
          <nav className="nav">
            {nav.map(([group, links]) => (
              <div key={group}>
                <div className="nav-group">{group}</div>
                {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}{to === '/orders' && <OrdersBadge />}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <div>Environment</div>
            <EnvSwitch />
            {me && <div className="small" style={{ color: '#cbd5e1' }}>Signed in as <b>{me.name}</b>{me.role === 'admin' ? ' · admin' : ''}</div>}
            <button className="btn ghost sm" onClick={async () => { await post('/api/auth/logout'); location.reload(); }}>Sign out</button>
          </div>
        </aside>
        <main className="main">
          <div className="topbar-d"><AlertsBell /></div>
          <StageBanner />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/test-plan" element={<TestPlan />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/:id" element={<ProductDetail />} />
            <Route path="/bulk" element={<BulkEdit />} />
            <Route path="/taxonomy" element={<Taxonomy />} />
            <Route path="/taxonomy/:id" element={<ItemTypeDetail />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/target-catalog" element={<TargetCatalog />} />
            <Route path="/listing-errors" element={<ListingErrors />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/returns" element={<Returns />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/console" element={<Console />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/go-live" element={<GoLive />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

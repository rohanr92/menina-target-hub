import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { get, post, put, setUnauthorizedHandler } from './lib/api';
import { Btn, useToast } from './components/ui';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
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
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="box" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await post('/api/auth/login', { password: pw }); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
      }}>
        <div className="brand" style={{ padding: 0 }}><span className="mark" /><div>Target Hub<small>Menina Step · Target Plus</small></div></div>
        <input type="password" placeholder="Team password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
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
  ['Tools', [['/reports', 'Reports'], ['/console', 'API console'], ['/logs', 'API log'], ['/settings', 'Settings']]],
];

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    get('/api/auth/me').then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <BrowserRouter>
      <div className="shell">
        <aside className="side">
          <div className="brand"><span className="mark" /><div>Target Hub<small>Menina Step</small></div></div>
          <nav className="nav">
            {NAV.map(([group, links]) => (
              <div key={group}>
                <div className="nav-group">{group}</div>
                {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <div>Environment</div>
            <EnvSwitch />
            <button className="btn ghost sm" onClick={async () => { await post('/api/auth/logout'); location.reload(); }}>Sign out</button>
          </div>
        </aside>
        <main className="main">
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
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

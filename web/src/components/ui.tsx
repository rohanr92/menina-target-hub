import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: 'info' | 'error' };
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">{list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fnRef.current()); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload, setData };
}

/** Run an action with a busy flag and toast on success / failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (success) toast(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e: any) {
      toast(e.message ?? String(e), 'error');
      return undefined;
    } finally { setBusy(null); }
  }, [toast]);
  return { busy, run };
}

// ---------- components ----------
export function Btn({ busy, children, kind, size, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; kind?: 'primary' | 'ghost' | 'danger'; size?: 'sm' }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={['btn', kind, size, rest.className].filter(Boolean).join(' ')}>
      {busy && <span className="spin" />}{children}
    </button>
  );
}

export function Card({ title, actions, children, pad = true }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; pad?: boolean }) {
  return (
    <div className="card">
      {(title || actions) && <div className="card-h"><h3>{title}</h3><div className="row">{actions}</div></div>}
      {pad ? <div className="card-b">{children}</div> : children}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      <div className="row">{children}</div>
    </div>
  );
}

const STATUS_KIND: Record<string, string> = {
  APPROVED: 'ok', VALIDATED: 'ok', COMPLETE: 'ok', SHIPPED: 'ok', Complete: 'ok', done: 'ok', ok: 'ok', PROCESSED: 'ok',
  PENDING: 'warn', INITIATED: 'warn', PROCESSING: 'warn', RELEASED_FOR_SHIPMENT: 'warn', ACKNOWLEDGED_BY_SELLER: '', PARTIALLY_SHIPPED: 'warn', REVIEW: 'warn', pending: 'warn', running: 'warn', 'In Progress': 'warn',
  REJECTED: 'bad', SUSPENDED: 'bad', ERROR: 'bad', CANCELED: '', BLOCKED: 'bad', failed: 'bad', error: 'bad', CRITICAL: 'bad',
  UNLISTED: '', REFUNDED: '',
};
export function Status({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  const k = STATUS_KIND[value] ?? '';
  return <span className={`badge ${k}`}><span className="dot" />{value.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(1100px, 100%)' } : undefined}>
        <div className="card-h"><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="card-b">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function Loading() { return <div className="empty"><span className="spin" /></div>; }
export function ErrorBox({ error }: { error: string }) { return <div className="card"><div className="card-b bad">{error}</div></div>; }
export function Json({ value }: { value: any }) { return <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, React.ReactNode][] }) {
  return <div className="tabs">{items.map(([k, label]) => <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>)}</div>;
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="btn ghost sm" onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>{done ? 'Copied' : 'Copy'}</button>;
}

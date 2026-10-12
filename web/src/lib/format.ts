export function dt(v?: string | Date | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(+d)) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function ago(v?: string | Date | null) {
  if (!v) return '—';
  const s = (Date.now() - +new Date(v)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const money = (n?: number | string | null) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2)}`);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Text helpers for Target content rules (no HTML in descriptions/bullets).
export function stripHtml(html?: string | null): string {
  if (!html) return '';
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Long description without the bullet list (bullets are sent separately). */
export function descriptionWithoutList(html?: string | null): string {
  if (!html) return '';
  return stripHtml(html.replace(/<(ul|ol)[\s\S]*?<\/\1>/gi, ' ')).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pull <li> items out of an HTML description as candidate feature bullets. */
export function bulletsFromHtml(html?: string | null): string[] {
  if (!html) return [];
  const out: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = stripHtml(m[1]).replace(/\s+/g, ' ').trim();
    if (t) out.push(t.slice(0, 120));
  }
  return out.slice(0, 15);
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
export const hasHtml = (s: string) => /<[a-z/][^>]*>/i.test(s);

/** Fill {token} placeholders. */
export function fillTemplate(tpl: string, vars: Record<string, string | undefined | null>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString()).replace(/\s+-\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

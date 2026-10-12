import { lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const MAX = 20_000;
const trim = (s?: string | null) => (s == null ? null : s.length > MAX ? s.slice(0, MAX) + `…[+${s.length - MAX} chars]` : s);

export async function logApi(entry: {
  service: 'target' | 'shopify';
  env?: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  requestBody?: string | null;
  responseBody?: string | null;
  error?: string | null;
  source?: string;
}) {
  try {
    await db.insert(schema.apiLogs).values({
      ...entry,
      requestBody: trim(entry.requestBody),
      responseBody: trim(entry.responseBody),
      error: trim(entry.error),
    });
  } catch (e) {
    console.error('api log write failed', e);
  }
}

/** Keep the log table small: drop entries older than N days. */
export async function pruneLogs(days = 30) {
  await db.delete(schema.apiLogs).where(lt(schema.apiLogs.createdAt, new Date(Date.now() - days * 864e5)));
}

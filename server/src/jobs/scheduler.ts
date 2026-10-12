// Background jobs. Each job records a JobRun so the dashboard shows what ran and when.
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { pruneLogs } from '../lib/apilog.js';
import { getSync } from '../lib/settings.js';
import { refreshVariantsFromShopify } from '../services/catalog.js';
import { refreshPending } from '../services/items.js';
import { pollOrders, syncTrackingFromShopify } from '../services/orders.js';
import { refreshOpenReports } from '../services/reports.js';
import { enqueueMany, startWorker } from '../services/sync.js';
import { isNotNull } from 'drizzle-orm';

const lastRun = new Map<string, number>();
const busy = new Set<string>();

export async function runJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(job)) throw new Error(`${job} is already running`);
  busy.add(job);
  const [run] = await db.insert(schema.jobRuns).values({ job, status: 'running' }).returning();
  try {
    const result = await fn();
    await db.update(schema.jobRuns).set({ status: 'ok', message: JSON.stringify(result ?? null).slice(0, 2000), finishedAt: new Date() }).where(eq(schema.jobRuns.id, run.id));
    return result;
  } catch (e: any) {
    await db.update(schema.jobRuns).set({ status: 'error', message: String(e?.message ?? e).slice(0, 2000), finishedAt: new Date() }).where(eq(schema.jobRuns.id, run.id));
    throw e;
  } finally {
    busy.delete(job);
    lastRun.set(job, Date.now());
  }
}

/** Pull Shopify stock/prices for every live item and queue any changes (also re-sends drift). */
export async function reconcileInventoryAndPrice() {
  const sync = await getSync();
  const rows = await db.select({ id: schema.variants.id, sourceId: schema.variants.sourceId, inventory: schema.variants.inventory, price: schema.variants.price, compareAtPrice: schema.variants.compareAtPrice })
    .from(schema.variants).where(and(isNotNull(schema.variants.targetProductId), eq(schema.variants.syncEnabled, true)));
  await refreshVariantsFromShopify(rows);
  const ids = rows.map((r) => r.id);
  // tasks compare with what was last sent, so unchanged items cost no Target calls
  if (sync.inventoryEnabled) await enqueueMany('inventory', ids);
  if (sync.priceEnabled) await enqueueMany('price', ids);
  return { items: ids.length };
}

function due(job: string, minutes: number) {
  return Date.now() - (lastRun.get(job) ?? 0) >= minutes * 60_000;
}

export function startScheduler() {
  startWorker();
  setInterval(async () => {
    const s = await getSync().catch(() => null);
    if (!s) return;
    const tick = async (job: string, minutes: number, enabled: boolean, fn: () => Promise<any>) => {
      if (!enabled || busy.has(job) || !due(job, minutes)) return;
      lastRun.set(job, Date.now());
      runJob(job, fn).catch((e) => console.error(`[job ${job}]`, e?.message ?? e));
    };
    await tick('orders', s.ordersIntervalMin, s.ordersEnabled, pollOrders);
    await tick('tracking', s.ordersIntervalMin, s.ordersEnabled && s.syncTrackingFromShopify, syncTrackingFromShopify);
    await tick('inventory', s.inventoryIntervalMin, s.inventoryEnabled || s.priceEnabled, reconcileInventoryAndPrice);
    await tick('item-status', s.statusIntervalMin, true, refreshPending);
    await tick('reports', 2, true, refreshOpenReports);
    await tick('cleanup', 24 * 60, true, async () => {
      await pruneLogs(30);
      await db.delete(schema.syncTasks).where(and(sql`status IN ('done','failed')`, lt(schema.syncTasks.updatedAt, new Date(Date.now() - 7 * 864e5))));
      await db.delete(schema.jobRuns).where(lt(schema.jobRuns.startedAt, new Date(Date.now() - 14 * 864e5)));
      return 'ok';
    });
  }, 30_000);
}

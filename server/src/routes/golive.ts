import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getActiveEnv, getSync, getTargetCreds, setSetting } from '../lib/settings.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

/**
 * Go-live helpers. The hub keeps one set of product / order rows, and during testing they point at STAGE
 * (stage product ids, TCINs, test stock, test orders). Before switching to PRODUCTION those links must be
 * cleared, or the hub would push test stock / prices to the wrong items.
 */
export default async function (app: FastifyInstance) {
  app.get('/api/golive/status', async () => {
    const q = async (s: any) => ((await db.execute(s)).rows[0] as any) ?? {};
    const stageSeller = (await getTargetCreds('stage')).sellerId ?? '';
    const prod = await getTargetCreds('production');
    const sync = await getSync();
    const v = await q(sql`SELECT
      count(*) FILTER (WHERE target_product_id IS NOT NULL)::int AS linked,
      count(*) FILTER (WHERE overrides ? 'fixed_qty')::int AS fixed_stock,
      count(*) FILTER (WHERE overrides ? 'list_price')::int AS fixed_price
      FROM variants`);
    const p = await q(sql`SELECT count(*) FILTER (WHERE target_parent_id IS NOT NULL)::int AS parents FROM products`);
    const o = await q(sql`SELECT count(*)::int AS orders FROM orders WHERE raw->>'seller_id' = ${stageSeller}`);
    const t = await q(sql`SELECT count(*)::int AS tasks FROM sync_tasks WHERE status IN ('pending','running','failed')`);
    const d = await q(sql`SELECT count(*)::int AS dcs FROM distribution_centers`);
    return {
      activeEnv: await getActiveEnv(),
      productionReady: !!(prod.apiKey && prod.sellerId && (prod.authMode !== 'oauth' || prod.oauth?.refreshToken)),
      stageData: { linkedSkus: v.linked, parents: p.parents, fixedStock: v.fixed_stock, fixedPrice: v.fixed_price, stageOrders: o.orders, queuedTasks: t.tasks, distributionCenters: d.dcs },
      syncOn: { ordersEnabled: sync.ordersEnabled, autoAcknowledge: sync.autoAcknowledge, inventoryEnabled: sync.inventoryEnabled, priceEnabled: sync.priceEnabled, pushOrdersToShopify: sync.pushOrdersToShopify },
    };
  });

  /** Clears every STAGE link and pauses all automatic sync. Shopify products and your edits stay. */
  app.post('/api/golive/clear-stage', async (req) => {
    const b = (req.body ?? {}) as { confirm?: string };
    if (b.confirm !== 'CLEAR') throw bad('Type CLEAR to confirm');
    if ((await getActiveEnv()) !== 'stage') throw bad('Run this while the hub is still on Stage (switch back to Stage first).');
    const stageSeller = (await getTargetCreds('stage')).sellerId ?? '';

    // 1) pause automatic sync, so nothing is sent to production until you turn it on yourself
    const cur = await getSync();
    await setSetting('sync', { ...cur, ordersEnabled: false, autoAcknowledge: false, inventoryEnabled: false, priceEnabled: false });

    // 2) unlink SKUs from stage items, drop test stock / test prices
    const vr = await db.execute(sql`UPDATE variants SET
      target_product_id = NULL, tcin = NULL, listing_status = NULL, validation_status = NULL, errors = NULL,
      last_price_sent = NULL, last_qty_sent = NULL, last_price_sent_at = NULL, last_qty_sent_at = NULL, status_checked_at = NULL,
      overrides = overrides - 'fixed_qty' - 'list_price' - 'offer_price' - 'map_price'
      WHERE target_product_id IS NOT NULL OR overrides ?| array['fixed_qty','list_price','offer_price','map_price']`);
    const pr = await db.execute(sql`UPDATE products SET
      target_parent_id = NULL, target_parent_tcin = NULL, parent_status = NULL, parent_validation = NULL, parent_errors = NULL,
      last_pushed_at = NULL, last_push_error = NULL
      WHERE target_parent_id IS NOT NULL OR last_pushed_at IS NOT NULL OR last_push_error IS NOT NULL`);

    // 3) remove the stage test orders, queued stage pushes and stage distribution centers
    const or = await db.execute(sql`DELETE FROM orders WHERE raw->>'seller_id' = ${stageSeller}`);
    await db.delete(schema.syncTasks);
    await db.delete(schema.distributionCenters);

    return { variants: vr.rowCount ?? 0, products: pr.rowCount ?? 0, orders: or.rowCount ?? 0, syncPaused: true };
  });
}

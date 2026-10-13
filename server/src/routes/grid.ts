// Bulk mapping grid API (see services/grid.ts)
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { saveItemTypes } from '../services/taxonomy.js';
import { allRows, autoMap, categorySetupStatus, startCategorySetup, buildRows, exportSheet, gridColumns, gridPage, gridTabs, importSheet, saveCells, type GridQuery } from '../services/grid.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
const list = (x: any) => (Array.isArray(x) ? x : typeof x === 'string' && x ? x.split(',') : []).map((s: string) => s.trim()).filter(Boolean);

function query(q: any): GridQuery {
  return {
    itemTypeId: q.itemTypeId || undefined, q: q.q || undefined, state: q.state || undefined,
    productIds: list(q.products), variantIds: list(q.variants), page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 25,
  };
}

export default async function (app: FastifyInstance) {
  app.get('/api/grid/tabs', async () => gridTabs());

  /** One click: allowed item types report -> item types -> fields -> dropdown values. Runs in the background. */
  app.post('/api/grid/setup-categories', async (req) => {
    const b = (req.body ?? {}) as { onlyIds?: string[]; withValues?: boolean; skipReport?: boolean };
    return startCategorySetup({ onlyIds: Array.isArray(b.onlyIds) ? b.onlyIds.map(String) : undefined, withValues: b.withValues, skipReport: !!b.skipReport });
  });
  app.get('/api/grid/setup-categories', async () => categorySetupStatus());

  /** Add item types found by name in Target's taxonomy, then load their fields and dropdown values. */
  app.post('/api/grid/add-categories', async (req) => {
    const { items } = (req.body ?? {}) as { items: { id: string; name: string }[] };
    const clean = (Array.isArray(items) ? items : []).map((x) => ({ id: String(x.id ?? '').trim(), name: String(x.name ?? '').trim() })).filter((x) => x.id && x.name);
    if (!clean.length) throw bad('Pick at least one item type');
    await saveItemTypes(clean);
    return startCategorySetup({ onlyIds: clean.map((x) => x.id) });
  });
  app.get('/api/grid/columns', async (req) => gridColumns((req.query as any).itemTypeId || null));
  app.get('/api/grid', async (req) => {
    const f = query(req.query);
    const [page, columns] = await Promise.all([gridPage(f), gridColumns(f.itemTypeId && f.itemTypeId !== 'none' ? f.itemTypeId : null)]);
    return { ...page, columns };
  });

  /** One SKU with every value, where it comes from, images and problems. */
  app.get('/api/grid/variant/:id', async (req) => {
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, (req.params as any).id) });
    if (!v) throw bad('SKU not found', 404);
    const p = (await db.query.products.findFirst({ where: eq(schema.products.id, v.productId) }))!;
    const [row] = await buildRows([p], [v]);
    return { row, columns: await gridColumns(p.itemTypeId) };
  });

  /** Save edited cells. Body: { cells: [{ variantId, key, value }] }  ·  key "__itemType" sets the product's item type. */
  app.post('/api/grid/cells', async (req) => {
    const { cells } = (req.body ?? {}) as { cells: any[] };
    if (!Array.isArray(cells) || !cells.length) throw bad('Nothing to save');
    return saveCells(cells.slice(0, 20000));
  });

  /** Same value for many SKUs. Body: { variantIds, key, value } */
  app.post('/api/grid/bulk', async (req) => {
    const { variantIds, key, value } = (req.body ?? {}) as { variantIds: string[]; key: string; value: any };
    if (!Array.isArray(variantIds) || !variantIds.length || !key) throw bad('Select SKUs and a field');
    return saveCells(variantIds.map((variantId) => ({ variantId, key, value })));
  });

  app.post('/api/grid/automap', async (req) => {
    const b = (req.body ?? {}) as { variantIds?: string[]; filter?: any; overwrite?: boolean; setItemType?: boolean; defaults?: Record<string, any> };
    let ids = Array.isArray(b.variantIds) ? b.variantIds.map(String) : [];
    if (!ids.length && b.filter) ids = (await allRows(query(b.filter))).map((r) => r.variantId);
    return autoMap(ids, { overwrite: !!b.overwrite, setItemType: b.setItemType !== false, defaults: b.defaults });
  });

  /** Download an Excel sheet for one item type. Body: { itemTypeId, variantIds?, filter?, blank? } */
  app.post('/api/grid/sheet', async (req, reply) => {
    const b = (req.body ?? {}) as { itemTypeId: string; variantIds?: string[]; filter?: any; blank?: boolean };
    if (!b.itemTypeId || b.itemTypeId === 'none') throw bad('Choose an item type first. Each sheet is built for one item type (like Target\'s template).');
    let rows: Awaited<ReturnType<typeof allRows>> = [];
    if (!b.blank) {
      rows = b.variantIds?.length ? await allRows({ variantIds: b.variantIds }) : await allRows({ ...query(b.filter ?? {}), itemTypeId: b.itemTypeId });
      rows = rows.filter((r) => r.itemTypeId === b.itemTypeId);
    }
    const buf = await exportSheet(b.itemTypeId, rows);
    const it = await db.query.itemTypes.findFirst({ where: eq(schema.itemTypes.id, b.itemTypeId) });
    const name = `target-${(it?.name ?? 'items').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${b.blank ? 'template' : `${rows.length}-skus`}.xlsx`;
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(buf);
  });

  app.post('/api/grid/sheet/upload', async (req) => {
    const file = await req.file();
    if (!file) throw bad('No file');
    return importSheet(await file.toBuffer(), file.filename);
  });
}

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runJob } from '../jobs/scheduler.js';
import { mockUpc, validateBarcode } from '../services/barcode.js';
import { buildProduct, computePrice, detectOptions, detectTheme, priceIssues } from '../services/builder.js';
import { importByCodes, importFromHub, importFromShopify, importGenericProducts } from '../services/catalog.js';
import { attrKey, loadTaxo } from '../services/builder.js';
import { fetchTargetForProduct, importUnmatchedFromShopify, linkMatches, matchTargetItems, syncTargetCatalog } from '../services/targetCatalog.js';
import { pushLogistics, pushProduct, refreshAllStatuses, refreshProductStatus, unlistVariant } from '../services/items.js';
import { desiredQuantities, enqueue } from '../services/sync.js';
import { parseCsv } from '../services/taxonomy.js';
import * as T from '../target/api.js';

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

export default async function (app: FastifyInstance) {
  app.get('/api/products', async (req) => {
    const { q, itemTypeId, state, page = '1' } = req.query as Record<string, string>;
    const conds: any[] = [];
    if (q) conds.push(or(ilike(schema.products.title, `%${q}%`), sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND (v.sku ILIKE ${'%' + q + '%'} OR v.barcode ILIKE ${'%' + q + '%'} OR v.tcin = ${q}))`));
    if (itemTypeId === 'none') conds.push(isNull(schema.products.itemTypeId));
    else if (itemTypeId) conds.push(eq(schema.products.itemTypeId, itemTypeId));
    if (state === 'on_target') conds.push(sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.target_product_id IS NOT NULL)`);
    if (state === 'not_on_target') conds.push(sql`NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.target_product_id IS NOT NULL)`);
    if (state === 'errors') conds.push(or(isNotNull(schema.products.lastPushError), sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.listing_status IN ('REJECTED','SUSPENDED'))`));
    const where = conds.length ? and(...conds) : undefined;
    const limit = 50, offset = (Number(page) - 1) * limit;
    const rows = await db.select().from(schema.products).where(where).orderBy(desc(schema.products.updatedAt)).limit(limit).offset(offset);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.products).where(where);
    const ids = rows.map((r) => r.id);
    const vs = ids.length ? await db.select().from(schema.variants).where(inArray(schema.variants.productId, ids)) : [];
    const types = await db.select({ id: schema.itemTypes.id, name: schema.itemTypes.name }).from(schema.itemTypes);
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    return {
      total: n, page: Number(page), pageSize: limit,
      items: rows.map((p) => {
        const mine = vs.filter((v) => v.productId === p.id);
        const statuses: Record<string, number> = {};
        for (const v of mine) { const s = v.listingStatus ?? (v.targetProductId ? 'SENT' : 'NOT SENT'); statuses[s] = (statuses[s] ?? 0) + 1; }
        return {
          id: p.id, title: p.title, image: (p.images as string[])[0] ?? null, vendor: p.vendor, productType: p.productType,
          itemTypeId: p.itemTypeId, itemTypeName: p.itemTypeId ? typeName.get(p.itemTypeId) ?? p.itemTypeId : null,
          theme: detectTheme(p, mine), variants: mine.length, inventory: mine.reduce((a, v) => a + v.inventory, 0),
          statuses, parentTcin: p.targetParentTcin, lastPushError: p.lastPushError, lastPushedAt: p.lastPushedAt, source: p.source,
        };
      }),
    };
  });

  app.get('/api/products/:id', async (req) => {
    const id = (req.params as any).id;
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
    if (!p) throw bad('Product not found', 404);
    const vs = (await db.select().from(schema.variants).where(eq(schema.variants.productId, id))).sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));
    const enriched = await Promise.all(vs.map(async (v) => {
      const price = await computePrice(v);
      let qty: Record<string, number> | null = null;
      try { qty = await desiredQuantities(v); } catch { qty = null; }
      return { ...v, barcodeCheck: validateBarcode(v.barcode), targetPrice: price, priceIssues: priceIssues(price), targetQty: qty };
    }));
    return { product: p, variants: enriched, detected: { theme: detectTheme({ ...p, theme: null } as any, vs.filter((v) => v.syncEnabled)), ...detectOptions(p) } };
  });

  app.get('/api/products/:id/preview', async (req) => buildProduct((req.params as any).id));

  /** Side by side: Target attribute | value we send | where it comes from | what Target has now. */
  app.get('/api/products/:id/mapping', async (req) => {
    const id = (req.params as any).id;
    const built = await buildProduct(id);
    const p = (await db.query.products.findFirst({ where: eq(schema.products.id, id) }))!;
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, id));
    const taxo = p.itemTypeId ? await loadTaxo(p.itemTypeId) : { attrs: [] as any[] };
    const attrs = new Map<string, any>(taxo.attrs.map((a: any) => [attrKey(a), a] as [string, any]));
    const blocks = [
      ...(built.parent ? [{ scope: 'parent', level: 'VAP', sku: built.parent.external_id, targetProductId: p.targetParentId, tcin: p.targetParentTcin, status: p.parentStatus, title: 'Parent (VAP)' }] : []),
      ...built.items.map((it) => {
        const v = vs.find((x) => x.id === it.variantId);
        return { scope: it.sku || it.variantId || '', level: it.payload.relationship_type, sku: it.sku, targetProductId: v?.targetProductId, tcin: v?.tcin, status: v?.listingStatus, title: Object.values((v?.options ?? {}) as Record<string, string>).join(' / ') || v?.title || it.sku };
      }),
    ];
    const ids = blocks.map((b) => b.targetProductId).filter(Boolean) as string[];
    const onTarget = ids.length ? await db.select().from(schema.targetItems).where(inArray(schema.targetItems.id, ids)) : [];
    return {
      theme: built.theme, itemType: built.itemType, issues: built.issues,
      items: blocks.map((b) => {
        const t = onTarget.find((x) => x.id === b.targetProductId);
        const tv = (key: string) => t ? (t.fields as any[]).filter((f) => f.name === key).map((f) => f.value).join(' | ') : null;
        const rows = (built.trace[b.scope] ?? []).reduce((acc: any[], r) => {
          const prev = acc.find((x) => x.key === r.key);
          if (prev) { prev.value += ` | ${r.value}`; return acc; }
          const a: any = attrs.get(r.key);
          acc.push({ key: r.key, name: a?.name ?? r.key, required: !!a?.required, type: a?.type ?? null, group: a?.group ?? null, value: r.value, source: r.source, original: r.original ?? null });
          return acc;
        }, []);
        for (const r of rows) { r.onTarget = tv(r.key); r.differs = t ? (r.onTarget ?? '') !== r.value : null; }
        // required attributes that got no value
        const sent = new Set(rows.map((r) => r.key));
        const missing = b.level === 'VAP' ? [] : taxo.attrs.filter((a: any) => a.required && a.group !== 'LOGISTICS' && !sent.has(attrKey(a))).map((a: any) => ({ key: attrKey(a), name: a.name }));
        // values on Target that we don't send
        const extra = t ? (t.fields as any[]).filter((f) => !sent.has(f.name)).map((f) => ({ key: f.name, onTarget: f.value })) : [];
        return { ...b, onTargetFetchedAt: t?.fetchedAt ?? null, rows, missing, extra };
      }),
    };
  });
  app.post('/api/products/:id/fetch-target', async (req) => fetchTargetForProduct((req.params as any).id));

  // ---- Target catalog (what's already live on Target) ----
  app.get('/api/target-catalog', async (req) => {
    const { filter, q } = req.query as any;
    const env = (await (await import('../lib/settings.js')).getActiveEnv());
    const conds: any[] = [eq(schema.targetItems.env, env)];
    if (filter === 'matched') conds.push(sql`${schema.targetItems.matchedProductId} IS NOT NULL`);
    if (filter === 'unmatched') conds.push(sql`${schema.targetItems.matchedProductId} IS NULL`);
    if (filter === 'linked') conds.push(sql`EXISTS (SELECT 1 FROM variants v WHERE v.target_product_id = ${schema.targetItems.id}) OR EXISTS (SELECT 1 FROM products p WHERE p.target_parent_id = ${schema.targetItems.id})`);
    if (q) conds.push(or(ilike(schema.targetItems.title, `%${q}%`), ilike(schema.targetItems.externalId, `%${q}%`), ilike(schema.targetItems.barcode, `%${q}%`), eq(schema.targetItems.tcin, q)));
    const rows = await db.select().from(schema.targetItems).where(and(...conds)).orderBy(asc(schema.targetItems.parentId), asc(schema.targetItems.externalId)).limit(2000);
    const pids = [...new Set(rows.map((r) => r.matchedProductId).filter(Boolean))] as string[];
    const prods = pids.length ? await db.select({ id: schema.products.id, title: schema.products.title, images: schema.products.images }).from(schema.products).where(inArray(schema.products.id, pids)) : [];
    const linkedV = await db.select({ t: schema.variants.targetProductId }).from(schema.variants).where(isNotNull(schema.variants.targetProductId));
    const linkedP = await db.select({ t: schema.products.targetParentId }).from(schema.products).where(isNotNull(schema.products.targetParentId));
    const linked = new Set([...linkedV.map((x) => x.t), ...linkedP.map((x) => x.t)]);
    const all = await db.select({ m: schema.targetItems.matchBy, rt: schema.targetItems.relationshipType, mp: schema.targetItems.matchedProductId, id: schema.targetItems.id }).from(schema.targetItems).where(eq(schema.targetItems.env, env));
    return {
      env,
      stats: {
        total: all.length, parents: all.filter((x) => x.rt === 'VAP').length,
        byUpc: all.filter((x) => x.m === 'upc').length, bySku: all.filter((x) => x.m === 'sku').length,
        unmatched: all.filter((x) => !x.mp).length, linked: all.filter((x) => linked.has(x.id)).length,
      },
      items: rows.map((r) => ({ ...r, fields: undefined, linked: linked.has(r.id), product: prods.find((p) => p.id === r.matchedProductId) ?? null })),
    };
  });
  app.post('/api/target-catalog/sync', async () => runJob('target-catalog', syncTargetCatalog));
  app.post('/api/target-catalog/match', async () => matchTargetItems());
  app.post('/api/target-catalog/link', async (req) => linkMatches({ ids: (req.body as any)?.ids }));
  app.post('/api/target-catalog/import-unmatched', async () => {
    const r = await runJob('import-by-upc', importUnmatchedFromShopify);
    for (const id of (r as any).changedVariantIds ?? []) { await enqueue('inventory', id); }
    return r;
  });
  app.get('/api/target-catalog/:id', async (req) => db.query.targetItems.findFirst({ where: eq(schema.targetItems.id, (req.params as any).id) }));

  app.patch('/api/products/:id', async (req) => {
    const id = (req.params as any).id;
    const b = req.body as any;
    const allowed = ['itemTypeId', 'theme', 'sizeOption', 'colorOption', 'bullets', 'overrides', 'parentExternalId', 'logistics', 'enabled'];
    const set: any = {};
    for (const k of allowed) if (b[k] !== undefined) set[k] = b[k] === '' ? null : b[k];
    if (set.bullets) set.bullets = (set.bullets as string[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
    if (set.parentExternalId !== undefined && p?.targetParentId && set.parentExternalId !== p.parentExternalId) throw bad('Parent SKU cannot change after the parent exists on Target');
    await db.update(schema.products).set(set).where(eq(schema.products.id, id));
    return db.query.products.findFirst({ where: eq(schema.products.id, id) });
  });

  app.post('/api/products/bulk', async (req) => {
    const { ids, itemTypeId, enabled } = req.body as { ids: string[]; itemTypeId?: string | null; enabled?: boolean };
    if (!ids?.length) throw bad('No products selected');
    const set: any = {};
    if (itemTypeId !== undefined) set.itemTypeId = itemTypeId || null;
    if (enabled !== undefined) set.enabled = enabled;
    await db.update(schema.products).set(set).where(inArray(schema.products.id, ids));
    return { updated: ids.length };
  });

  app.patch('/api/variants/:id', async (req) => {
    const id = (req.params as any).id;
    const b = req.body as any;
    const set: any = {};
    if (b.overrides !== undefined) set.overrides = b.overrides;
    if (b.syncEnabled !== undefined) set.syncEnabled = !!b.syncEnabled;
    if (b.regenerateMockBarcode) set.mockBarcode = mockUpc();
    if (b.mockBarcode !== undefined) {
      const chk = validateBarcode(b.mockBarcode);
      if (!chk.ok) throw bad(chk.message);
      set.mockBarcode = b.mockBarcode;
    }
    await db.update(schema.variants).set(set).where(eq(schema.variants.id, id));
    return db.query.variants.findFirst({ where: eq(schema.variants.id, id) });
  });

  app.post('/api/products/:id/push', async (req) => {
    const { force, onlyNew } = (req.body ?? {}) as { force?: boolean; onlyNew?: boolean };
    return pushProduct((req.params as any).id, { force, onlyNew });
  });
  app.post('/api/products/push-many', async (req) => {
    const { ids } = req.body as { ids: string[] };
    const out: any[] = [];
    for (const id of ids ?? []) out.push({ id, ...(await pushProduct(id)) });
    return out.map((r) => ({ id: r.id, ok: r.ok, blocked: (r as any).blocked, error: (r as any).error, errors: r.issues?.filter((i: any) => i.level === 'error').length }));
  });
  app.post('/api/products/:id/refresh', async (req) => refreshProductStatus((req.params as any).id));
  app.post('/api/products/refresh-all', async () => runJob('catalog-refresh', refreshAllStatuses));

  app.post('/api/variants/:id/unlist', async (req) => unlistVariant((req.params as any).id));
  app.post('/api/variants/:id/logistics', async (req) => pushLogistics((req.params as any).id));
  app.post('/api/products/:id/logistics', async (req) => {
    const vs = await db.select().from(schema.variants).where(and(eq(schema.variants.productId, (req.params as any).id), isNotNull(schema.variants.targetProductId)));
    for (const v of vs) await enqueue('logistics', v.id);
    return { queued: vs.length };
  });
  app.post('/api/variants/:id/price', async (req) => { await enqueue('price', (req.params as any).id, { force: true }); return { queued: true }; });
  app.post('/api/variants/:id/inventory', async (req) => { await enqueue('inventory', (req.params as any).id, { force: true }); return { queued: true }; });
  app.post('/api/products/:id/price-inventory', async (req) => {
    const vs = await db.select().from(schema.variants).where(and(eq(schema.variants.productId, (req.params as any).id), isNotNull(schema.variants.targetProductId)));
    for (const v of vs) { await enqueue('price', v.id, { force: true }); await enqueue('inventory', v.id, { force: true }); }
    return { queued: vs.length };
  });

  /** Live view of what Target has for one item. */
  app.get('/api/variants/:id/target', async (req) => {
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, (req.params as any).id) });
    if (!v?.targetProductId) throw bad('Item is not on Target yet');
    const safe = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e: any) { return { error: e.message }; } };
    return {
      product: await safe(() => T.getProduct(v.targetProductId!)),
      price: await safe(() => T.getPrice(v.targetProductId!)),
      quantities: await safe(() => T.getQuantities(v.targetProductId!)),
      logistics: await safe(() => T.getLogistics(v.targetProductId!)),
    };
  });

  // ---- imports ----
  app.post('/api/products/import/shopify', async (req) => {
    const { query, limit } = (req.body ?? {}) as { query?: string; limit?: number };
    const r = await runJob('shopify-import', () => importFromShopify({ query, limit }));
    for (const id of r.changedVariantIds) { await enqueue('inventory', id); await enqueue('price', id); }
    return r;
  });
  app.post('/api/products/import/hub', async () => runJob('hub-import', importFromHub));
  /** Paste UPCs / EANs / SKUs (any separator): imports the Shopify products that contain them. */
  app.post('/api/products/import/codes', async (req) => {
    const { codes } = req.body as { codes: string | string[] };
    const list = Array.isArray(codes) ? codes : String(codes ?? '').split(/[\s,;]+/);
    if (!list.filter(Boolean).length) throw bad('Paste at least one UPC or SKU');
    const r = await runJob('import-by-upc', () => importByCodes(list));
    await matchTargetItems().catch(() => undefined);
    return r;
  });
  app.post('/api/products/import/file', async (req) => {
    const file = await req.file();
    if (!file) throw bad('No file');
    const text = (await file.toBuffer()).toString('utf8');
    let list: any[];
    if (/^\s*[\[{]/.test(text)) { const j = JSON.parse(text); list = Array.isArray(j) ? j : j.products ?? []; }
    else {
      // CSV: one row per variant; grouped by product_id/handle
      const rows = parseCsv(text);
      const groups = new Map<string, any>();
      for (const r of rows) {
        const key = r.product_id || r.handle || r.title;
        if (!key) continue;
        const g = groups.get(key) ?? { id: key, handle: r.handle, title: r.title, description: r.description, vendor: r.vendor || r.brand, productType: r.product_type, tags: (r.tags ?? '').split(',').map((t: string) => t.trim()).filter(Boolean), images: (r.images ?? '').split('|').map((x: string) => x.trim()).filter(Boolean), options: [], variants: [] };
        const options: Record<string, string> = {};
        for (const k of ['size', 'color']) if (r[k]) options[k[0].toUpperCase() + k.slice(1)] = r[k];
        g.options = [...new Set([...g.options, ...Object.keys(options)])];
        g.variants.push({ sku: r.sku, barcode: r.barcode || r.upc, price: r.price, compareAtPrice: r.compare_at_price, inventory: Number(r.inventory || 0), weightLb: r.weight_lb ? Number(r.weight_lb) : null, imageUrl: r.image || null, options });
        groups.set(key, g);
      }
      list = [...groups.values()];
    }
    return importGenericProducts(list, 'file');
  });

  app.delete('/api/products/:id', async (req) => {
    const id = (req.params as any).id;
    const live = await db.select().from(schema.variants).where(and(eq(schema.variants.productId, id), isNotNull(schema.variants.targetProductId)));
    if (live.length) throw bad('This product has items on Target. Unlist them instead of deleting.');
    await db.delete(schema.products).where(eq(schema.products.id, id));
    return { ok: true };
  });

  app.get('/api/catalog/target', async (req) => {
    const { listing_status } = req.query as any;
    return T.getCatalog({ listing_status, expand: 'product_statuses' });
  });

  app.get('/api/listing-errors', async (req) => {
    const { severity, listing_status } = req.query as any;
    const rows = await T.getCatalogErrors({ error_severity: severity || undefined, listing_status: listing_status || undefined });
    const skus = rows.map((r: any) => r.external_id).filter(Boolean);
    const local = skus.length ? await db.select({ sku: schema.variants.sku, productId: schema.variants.productId }).from(schema.variants).where(inArray(schema.variants.sku, skus)) : [];
    const parents = skus.length ? await db.select({ sku: schema.products.parentExternalId, productId: schema.products.id }).from(schema.products).where(inArray(schema.products.parentExternalId, skus)) : [];
    const map = new Map([...local, ...parents].map((l) => [l.sku, l.productId]));
    return rows.map((r: any) => ({ ...r, productId: map.get(r.external_id) ?? null }));
  });

  app.get('/api/variants/lookup', async (req) => {
    const { sku } = req.query as any;
    return db.select().from(schema.variants).where(eq(schema.variants.sku, sku)).orderBy(asc(schema.variants.sku)).limit(5);
  });
}

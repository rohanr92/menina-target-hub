import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runJob } from '../jobs/scheduler.js';
import * as T from '../target/api.js';
import { SOURCE_FIELDS, attrKey, MappingRule } from '../services/builder.js';
import { importAttributeFile, itemTypeSummary, parseAllowedItemTypes, saveItemTypes, syncAttributes, syncSetupData, syncValues } from '../services/taxonomy.js';

const progress = new Map<string, { done: number; total: number }>();

export default async function (app: FastifyInstance) {
  app.get('/api/taxonomy/item-types', async () => {
    const types = await db.select().from(schema.itemTypes).orderBy(asc(schema.itemTypes.name));
    const counts = await db.execute(sql`SELECT item_type_id, count(*)::int AS attrs, sum(CASE WHEN required THEN 1 ELSE 0 END)::int AS required FROM attributes GROUP BY item_type_id`);
    const products = await db.execute(sql`SELECT item_type_id, count(*)::int AS n FROM products WHERE item_type_id IS NOT NULL GROUP BY item_type_id`);
    const c = new Map(counts.rows.map((r: any) => [r.item_type_id, r]));
    const pc = new Map(products.rows.map((r: any) => [r.item_type_id, r.n]));
    return types.map((t) => ({ ...t, raw: undefined, attrs: (c.get(t.id) as any)?.attrs ?? 0, required: (c.get(t.id) as any)?.required ?? 0, products: pc.get(t.id) ?? 0, valuesProgress: progress.get(t.id) ?? null }));
  });

  app.post('/api/taxonomy/item-types', async (req) => {
    const { id, name } = req.body as { id: string; name: string };
    if (!id || !name) throw Object.assign(new Error('id and name are required'), { statusCode: 400 });
    await saveItemTypes([{ id: String(id).trim(), name: String(name).trim() }]);
    return { ok: true };
  });

  app.delete('/api/taxonomy/item-types/:id', async (req) => {
    await db.delete(schema.itemTypes).where(eq(schema.itemTypes.id, (req.params as any).id));
    return { ok: true };
  });

  /** Upload the ALLOWED_ITEM_TYPES report file (JSON / CSV / XLSX) if downloading through the API isn't possible. */
  app.post('/api/taxonomy/item-types/upload', async (req) => {
    const file = await req.file();
    if (!file) throw Object.assign(new Error('No file'), { statusCode: 400 });
    const buf = await file.toBuffer();
    const isXlsx = /\.xlsx?$/i.test(file.filename) || /sheet|excel/.test(file.mimetype);
    const types = await parseAllowedItemTypes(isXlsx ? buf : buf.toString('utf8'), isXlsx ? 'excel' : file.mimetype);
    if (!types.length) throw Object.assign(new Error('No item types found in the file (need item type id + name columns)'), { statusCode: 400 });
    await saveItemTypes(types);
    return { count: types.length };
  });

  /** Upload Target's "Attributes And Values" / Bulk Product Data Template Excel: creates the item type with all its fields and values. */
  app.post('/api/taxonomy/import-attributes', async (req) => {
    const parts = req.parts();
    let buf: Buffer | null = null; const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === 'file') buf = await part.toBuffer();
      else fields[part.fieldname] = String((part as any).value ?? '');
    }
    if (!buf) throw Object.assign(new Error('No file'), { statusCode: 400 });
    return importAttributeFile(buf, { itemTypeId: fields.itemTypeId, itemTypeName: fields.itemTypeName });
  });

  app.get('/api/taxonomy/item-types/:id', async (req) => {
    const id = (req.params as any).id;
    const it = await db.query.itemTypes.findFirst({ where: eq(schema.itemTypes.id, id) });
    if (!it) throw Object.assign(new Error('Item type not found'), { statusCode: 404 });
    const attrs = await db.execute(sql`
      SELECT a.*, (SELECT count(*)::int FROM attribute_values v WHERE v.attr_id = a.id) AS value_count
      FROM attributes a WHERE a.item_type_id = ${id}
      ORDER BY a.required DESC, CASE a.attr_group WHEN 'CORE' THEN 0 WHEN 'SELLING' THEN 1 WHEN 'TAX' THEN 2 ELSE 3 END, a.name`);
    return {
      itemType: it,
      summary: await itemTypeSummary(id),
      attributes: attrs.rows.map((a: any) => ({
        id: a.id, attributeId: a.attribute_id, taxonomyId: a.taxonomy_id, name: a.name, mappedProperty: a.mapped_property, key: a.mapped_property || a.attribute_id,
        type: a.type, group: a.attr_group, required: a.required, maxSelections: a.max_selections, description: a.description,
        valueCount: a.value_count, valuesFetched: a.values_fetched,
      })),
      valuesProgress: progress.get(id) ?? null,
    };
  });

  app.get('/api/taxonomy/attributes/:attrId/values', async (req) => {
    const { q } = req.query as { q?: string };
    const where = q ? and(eq(schema.attributeValues.attrId, (req.params as any).attrId), ilike(schema.attributeValues.name, `%${q}%`)) : eq(schema.attributeValues.attrId, (req.params as any).attrId);
    return db.select().from(schema.attributeValues).where(where).orderBy(asc(schema.attributeValues.name)).limit(2000);
  });

  app.post('/api/taxonomy/item-types/:id/attributes', async (req) => {
    const id = (req.params as any).id;
    const n = await runJob(`attributes:${id}`, () => syncAttributes(id));
    return { attributes: n, summary: await itemTypeSummary(id) };
  });

  /** Value lists can take hundreds of calls; runs in the background and reports progress. */
  app.post('/api/taxonomy/item-types/:id/values', async (req) => {
    const id = (req.params as any).id;
    const { all } = (req.body ?? {}) as { all?: boolean };
    if (progress.has(id)) return { started: false, message: 'Already running', progress: progress.get(id) };
    progress.set(id, { done: 0, total: 0 });
    runJob(`values:${id}`, () => syncValues(id, !all, (done, total) => progress.set(id, { done, total })))
      .catch(() => undefined).finally(() => progress.delete(id));
    return { started: true };
  });

  app.get('/api/taxonomy/search', async (req) => {
    const { name } = req.query as { name: string };
    return T.searchItemTypes(name);
  });

  app.post('/api/taxonomy/setup', async () => runJob('setup-data', syncSetupData));
  app.get('/api/taxonomy/setup', async () => ({
    distributionCenters: await db.select().from(schema.distributionCenters),
    shippingMethods: await db.select().from(schema.shippingMethods).orderBy(asc(schema.shippingMethods.carrier)),
  }));
  app.get('/api/taxonomy/return-policies', async () => T.getReturnPolicies());
  app.get('/api/taxonomy/legalizations', async (req) => T.getLegalizations((req.query as any).type));

  // ---- mapping ----
  app.get('/api/mapping/:itemTypeId', async (req) => {
    const itemTypeId = (req.params as any).itemTypeId;
    const profile = await db.query.mappingProfiles.findFirst({ where: eq(schema.mappingProfiles.itemTypeId, itemTypeId) });
    const attrs = await db.select().from(schema.attributes).where(eq(schema.attributes.itemTypeId, itemTypeId));
    // option names + tags seen on products assigned to this item type help build value maps
    const prods = await db.select({ optionNames: schema.products.optionNames, tags: schema.products.tags }).from(schema.products).where(eq(schema.products.itemTypeId, itemTypeId)).limit(500);
    const options = [...new Set(prods.flatMap((p) => p.optionNames as string[]))];
    const optionValues = await db.execute(sql`
      SELECT key AS option, array_agg(DISTINCT value) AS values FROM variants v
      JOIN products p ON p.id = v.product_id, jsonb_each_text(v.options)
      WHERE p.item_type_id = ${itemTypeId} GROUP BY key`);
    return {
      rules: (profile?.rules as MappingRule[]) ?? [],
      attributes: attrs.filter((a) => a.group !== 'LOGISTICS').map((a) => ({ id: a.id, key: attrKey(a), name: a.name, type: a.type, group: a.group, required: a.required, maxSelections: a.maxSelections })),
      sourceFields: SOURCE_FIELDS,
      productOptions: options,
      optionValues: Object.fromEntries(optionValues.rows.map((r: any) => [r.option, r.values])),
      tags: [...new Set(prods.flatMap((p) => p.tags as string[]))].slice(0, 300),
    };
  });

  app.put('/api/mapping/:itemTypeId', async (req) => {
    const itemTypeId = (req.params as any).itemTypeId;
    const { rules } = req.body as { rules: MappingRule[] };
    const clean = (rules ?? []).filter((r) => r.key && r.source && r.source !== 'auto' || (r.valueMap && Object.keys(r.valueMap).length));
    await db.insert(schema.mappingProfiles).values({ itemTypeId, rules: clean })
      .onConflictDoUpdate({ target: schema.mappingProfiles.itemTypeId, set: { rules: clean } });
    return { rules: clean };
  });
}

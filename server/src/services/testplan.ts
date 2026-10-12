// Test plan tracker: Target's scenarios, auto-filled identifiers, export back into Target's workbook.
import ExcelJS from 'exceljs';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { SCENARIOS } from './testplanData.js';
import { itemTypeSummary } from './taxonomy.js';

export async function seedScenarios() {
  for (const s of SCENARIOS) {
    await db.insert(schema.testScenarios).values({ id: `${s.sheet}|${s.scenario}`, ...s }).onConflictDoNothing();
  }
}

export async function listScenarios() {
  return db.select().from(schema.testScenarios).orderBy(schema.testScenarios.sort);
}

export async function updateScenario(id: string, patch: { status?: string; identifiers?: string; date?: string | null }) {
  const set: any = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.identifiers !== undefined) set.identifiers = patch.identifiers;
  if (patch.date !== undefined) set.date = patch.date ? new Date(patch.date) : null;
  if (patch.status === 'Complete' && patch.date === undefined) set.date = new Date();
  await db.update(schema.testScenarios).set(set).where(eq(schema.testScenarios.id, id));
  return db.query.testScenarios.findFirst({ where: eq(schema.testScenarios.id, id) });
}

async function latestReport(type: string, statuses = ['COMPLETE']) {
  const rows = await db.select().from(schema.reportRequests).where(and(eq(schema.reportRequests.type, type), inArray(schema.reportRequests.status, statuses))).orderBy(desc(schema.reportRequests.createdAt)).limit(1);
  return rows[0];
}

export interface SuggestCtx { itemTypeId?: string; productId?: string; orderId?: string }

/** Build the "Scenario Identifiers" text from data already in the hub. */
export async function suggestIdentifiers(id: string, ctx: SuggestCtx): Promise<string> {
  const sc = await db.query.testScenarios.findFirst({ where: eq(schema.testScenarios.id, id) });
  if (!sc) throw new Error('Scenario not found');
  const n = sc.scenario;
  const lines: string[] = [];
  if (sc.sheet === 'Data Collection') {
    const it = ctx.itemTypeId ? await db.query.itemTypes.findFirst({ where: eq(schema.itemTypes.id, ctx.itemTypeId) }) : (await db.select().from(schema.itemTypes).limit(1))[0];
    if (n === '1.1') { const r = await latestReport('ALLOWED_ITEM_TYPES', ['PENDING', 'PROCESSING', 'COMPLETE']); if (r) lines.push(`Report id: ${r.id}`); }
    if (n === '2.1') {
      const r = await latestReport('ALLOWED_ITEM_TYPES');
      const types = await db.select().from(schema.itemTypes).limit(3);
      lines.push(`List download_url: ${r?.downloadUrl ?? ''}`, `List any 3 approved Item Types : ${types.map((t) => `${t.name} (${t.id})`).join(', ')}`);
    }
    if (n === '3.1') { const r = await latestReport('BULK_PRODUCT_DATA_TEMPLATE'); lines.push(`List download_url: ${r?.downloadUrl ?? ''}`); }
    if (it && ['4.1', '4.2', '4.3', '4.4', '4.5', '5.1', '6.1'].includes(n)) {
      const s = await itemTypeSummary(it.id);
      if (n === '4.1') lines.push(`Item Type : ${it.name} (${it.id})`);
      if (n === '4.2') lines.push(`Total Attributes : ${s.total}`);
      if (n === '4.3') lines.push(`Total Required Attributes : ${s.required}`);
      if (n === '4.4') lines.push(`Total Optional Attributes : ${s.optional}`);
      if (n === '4.5') lines.push(`4 Attribute Types: ${Object.keys(s.byType).join(', ')}`);
      if (n === '5.1') lines.push(`Number of feature bullets Target Plus allows: ${s.bullets || 15}`);
      if (n === '6.1') {
        const attrs = await db.select().from(schema.attributes).where(and(eq(schema.attributes.itemTypeId, it.id), eq(schema.attributes.type, 'VALUE'), eq(schema.attributes.group, 'SELLING')));
        for (const a of attrs) {
          const vals = await db.select().from(schema.attributeValues).where(eq(schema.attributeValues.attrId, a.id)).limit(3);
          if (vals.length >= 3) {
            lines.push(`item_type : ${it.name}`, `item_type_id : ${it.id}`, `attribute name : ${a.name}`, `mapped_property : ${a.mappedProperty || a.attributeId}`, `3 predefined values : ${vals.map((v) => v.name).join(', ')}`);
            break;
          }
        }
      }
    }
    if (n === '7.1') { const dcs = await db.select().from(schema.distributionCenters); lines.push(`List the 2 Distribution Center IDs: ${dcs.map((d) => `${d.id} (${d.name})`).join(', ')}`); }
    if (n === '8.1') { const m = await db.select().from(schema.shippingMethods).limit(3); lines.push(`List 3 SCAC shipping_methods: ${m.map((x) => `${x.shippingMethod} (SCAC ${x.scac})`).join(', ')}`); }
  } else if (sc.sheet === 'Item Create-Update' && ctx.productId) {
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, ctx.productId) });
    const vs = (await db.select().from(schema.variants).where(and(eq(schema.variants.productId, ctx.productId), isNotNull(schema.variants.targetProductId))))
      .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));
    const v = vs[0];
    const d = /price/i.test(sc.description) ? 'price' : /inventory/i.test(sc.description) ? 'inv' : /status/i.test(sc.description) ? 'status' : /logistics/i.test(sc.description) ? 'log' : 'ids';
    if (p?.targetParentId) {
      if (d === 'ids') {
        lines.push(`Parent SKU: ${p.parentExternalId ?? ''}`, `Parent TCIN: ${p.targetParentTcin ?? ''}`);
        vs.slice(0, 2).forEach((c, i) => lines.push(`Child SKU${i + 1}: ${c.sku ?? ''}`, `Child TCIN${i + 1}: ${c.tcin ?? ''}`));
      }
      if (d === 'price') vs.slice(0, 2).forEach((c, i) => lines.push(`Price${i + 1}: ${fmtPrice(c.lastPriceSent)}`));
      if (d === 'inv') vs.slice(0, 2).forEach((c, i) => lines.push(`Inventory${i + 1}: ${fmtQty(c.lastQtySent)}`));
      if (d === 'status') vs.slice(0, 2).forEach((c) => lines.push(`${c.sku}: listing_status ${c.listingStatus ?? ''}, validation_status ${c.validationStatus ?? ''}`));
    } else if (v) {
      if (d === 'ids') lines.push(`SKU: ${v.sku ?? ''}`, `product_id/id: ${v.targetProductId ?? ''}`, `TCIN: ${v.tcin ?? ''}`);
      if (d === 'status') lines.push(`listing_status : ${v.listingStatus ?? ''}`, `validation_status : ${v.validationStatus ?? ''}`);
      if (d === 'price') lines.push(`SKU: ${v.sku}`, `TCIN: ${v.tcin ?? ''}`, `Price (list/sale/map) : ${fmtPrice(v.lastPriceSent)}`);
      if (d === 'inv') lines.push(`SKU: ${v.sku}`, `TCIN: ${v.tcin ?? ''}`, `Inventory: ${fmtQty(v.lastQtySent)}`);
      if (d === 'log') lines.push(`SKU: ${v.sku}`, `TCIN: ${v.tcin ?? ''}`, `Values sent: ${JSON.stringify(p?.logistics ?? {})}`);
    }
  } else if ((sc.sheet === 'Order Fulfillment' || sc.sheet === 'Error Path') && ctx.orderId) {
    const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, ctx.orderId) });
    if (o) {
      lines.push(`Order: ${o.orderNumber ?? o.id} (id ${o.id})`);
      const f: any[] = Array.isArray(o.fulfillments) ? (o.fulfillments as any[]) : [];
      if (f.length) lines.push(`Shipment id: ${f.map((x) => x.id).join(', ')}`, `Tracking: ${[...new Set(f.map((x) => x.tracking_number))].join(', ')}`, `Method: ${[...new Set(f.map((x) => x.shipping_method))].join(', ')}`);
      const reasons = [...new Set(((o.raw as any).order_lines ?? []).map((l: any) => l.cancellation_reason).filter(Boolean))];
      if (reasons.length) lines.push(`Cancellation Reason: ${reasons.join(', ')}`);
    }
  } else if (sc.sheet === 'Reporting') {
    const recent = await db.select().from(schema.reportRequests).orderBy(desc(schema.reportRequests.createdAt)).limit(20);
    const pick = (t: string) => recent.find((r) => r.type === t);
    if (n === '1.1') lines.push(`List the download_url for three reports: ${recent.filter((r) => r.downloadUrl).slice(0, 3).map((r) => `${r.type}: ${r.downloadUrl}`).join(' | ')}`);
    if (n === '2.1' || n === '3.1') { const r = pick('ITEM_ERRORS') ?? pick('ITEM_ERRORS_V2'); if (r) lines.push(`id: ${r.id}`, `format: ${r.format}`, `status: ${r.status}`, `download_url: ${r.downloadUrl ?? ''}`); }
    if (n.startsWith('4.')) { const r = pick('ORDERS'); if (r) lines.push(`id: ${r.id}`, `status: ${r.status}`); }
    if (n.startsWith('5.')) { const r = pick('ALLOWED_ITEM_TYPES'); if (r) lines.push(`id: ${r.id}`, `download url: ${r.downloadUrl ?? ''}`); }
    if (n.startsWith('6.')) {
      const inv = recent.filter((r) => r.type === 'INVENTORY');
      const pub = inv.find((r) => (r.params as any)?.parameters?.is_published === true);
      const unpub = inv.find((r) => (r.params as any)?.parameters?.is_published === false);
      const r = n === '6.1' || n === '6.2' ? pub : unpub;
      if (r) lines.push(`id: ${r.id}`, `download url: ${r.downloadUrl ?? ''}`);
    }
  }
  return lines.join('\n');
}

function fmtPrice(p: any) { return p ? `${p.list_price ?? ''}/${p.offer_price ?? '-'}/${p.map_price ?? '-'}` : ''; }
function fmtQty(q: any) { return q ? Object.entries(q).map(([dc, n]) => `${n} (DC ${dc})`).join(', ') : ''; }

// ---- workbook export ----
export async function saveTemplate(buf: Buffer) {
  await setSetting('testplan.template', buf.toString('base64'));
}

export async function exportWorkbook(): Promise<Buffer> {
  const b64 = await getSetting<string | null>('testplan.template', null);
  if (!b64) throw new Error('Upload Target\'s test plan workbook first (Test Plan > Upload template).');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(b64, 'base64') as any);
  const rows = await listScenarios();
  for (const ws of wb.worksheets) {
    const mine = rows.filter((r) => r.sheet === ws.name);
    if (!mine.length) continue;
    let section = '';
    ws.eachRow((row) => {
      const a = String(row.getCell(1).value ?? '').trim();
      const b = String(row.getCell(2).value ?? '').trim();
      if (a && !b) { section = a; return; }
      const sc = mine.find((m) => m.scenario === a && (!m.section || m.section === section)) ?? mine.find((m) => m.scenario === a);
      if (!sc || sc.owner !== 'Partner') return;
      if (sc.status) {
        row.getCell(4).value = sc.status;
        if (sc.status === 'Complete') row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
      }
      if (sc.identifiers) row.getCell(5).value = sc.identifiers;
      if (sc.date) row.getCell(6).value = new Date(sc.date);
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

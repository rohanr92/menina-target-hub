# MeninaTargetHub

Target Plus **direct API integration** for Menina Step: Shopify → Target items, price, inventory, and Target orders → shipping / cancel / tracking, plus the full Target test plan.

- **Backend:** Node 20+, TypeScript, Fastify 5, Drizzle ORM, Postgres (`server/`)
- **Frontend:** React 18 + Vite (`web/`). It is built into `server/public` and served by the backend, so there is one Railway service
- **Secrets:** Target / Shopify keys are entered on the **Settings** page and stored **AES-256-GCM encrypted** in Postgres. They are never in the code, GitHub or Railway variables.

> Target rule: all API traffic must come from **your own** systems (in-house, US-based team). Run this on your own Railway account and don't share the Target credentials with anyone outside the company.

## What it does

| Area | Target test plan | Where |
|---|---|---|
| Allowed item types report (request, poll, download with `tgtrt`, import) | Data Collection 1.1, 2.1 | Taxonomy |
| Attributes per item type (SELLING, CORE, TAX, LOGISTICS), value lists, counts, attribute types, bullets | 3.1–6.1 | Taxonomy › item type |
| Distribution centers, shipping methods, return policies | 7.1, 8.1 | Taxonomy › Setup data |
| Mapping Shopify → Target attributes (field / option / tag / template / constant, value translation) | — | Taxonomy › item type › Mapping |
| Stand-alone items, size / color / size & color variations (VAP + VC), validation before sending | Items 1–4, 7 | Products |
| Price (list / offer / MAP rules), inventory per DC, logistics (all 4 fields) | Items 1.5–12 | Products, Price & inventory |
| Update item, update VC, unlist, status tracking, listing errors | Items 5–12 | Products, Listing errors |
| Orders: pull released, auto-acknowledge, address, full / partial ship, full / partial cancel | Order Fulfillment 1–6 | Orders |
| Push orders into Shopify **or** deduct Shopify stock; send Shopify tracking back to Target | — | Settings › Sync & rules |
| Reports: any type, date ranges, INVENTORY published/unpublished, cancel, preview, download | Reporting 1–6 | Reports |
| Error path: invalid item type / brand / tracking | Error Path 1–3 | API console presets |
| Test plan tracker with auto-fill + **export into Target's workbook** | all | Test plan |
| API log of every call (no secrets), background jobs, retry queue | — | API log, Dashboard |

Stage rules are built in: brand is forced to **Valor Fitness**, valid-checksum test UPCs are generated, and stage test orders **never write to your real Shopify store** unless you allow it.

## Run locally

```bash
# 1. Postgres: local install, or the Railway Postgres public URL
# 2. env
cp server/.env.example server/.env      # fill DATABASE_URL, ENCRYPTION_KEY (openssl rand -hex 32), APP_PASSWORD
# 3. install + start (API on :8080, web on :5173 with hot reload)
npm install
npm run dev
```
Open http://localhost:5173 and sign in with `APP_PASSWORD`. Migrations run automatically on start.

## Deploy on Railway

1. Push this repo to GitHub (private).
2. Railway → New Project → Deploy from GitHub repo → pick it. Add a **Postgres** database to the project.
3. On the app service, open **Variables** and set:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ENCRYPTION_KEY` = output of `openssl rand -hex 32`. **Keep a copy and never change it.** Changing it makes the saved keys unreadable.
   - `APP_PASSWORD` = team login password
   - `NODE_ENV` = `production`
   - `PUBLIC_URL` = `https://<your-app>.up.railway.app` (Settings › Networking › Generate domain)
4. Deploy. `railway.json` builds with `npm ci --include=dev && npm run build`, starts with `npm start`, and health-checks `/api/health`.
5. Open the app → **Settings** → enter the Target Stage credentials and the Shopify token → **Test connection**.

## First run (stage), in order
1. Settings › Target · Stage: API key, Seller ID, seller token **or** OAuth, tgtrt, return policy (AAC) → Test connection
2. Settings › Shopify: store domain + Admin API token → Test & load locations → map locations to DCs (after step 4)
3. Taxonomy: Request report → Check status → Import types
4. Taxonomy: Pull setup data (DCs + shipping methods)
5. Open your item type → Pull attributes → Pull value lists → Mapping (set package dimensions, color family, etc.) → Save
6. Products: Import from Shopify → select → set item type → open a product → check Validation → Send to Target
7. Target approves → Refresh status → price and inventory go out automatically (queued after creation)
8. Orders: Target releases test orders → Pull new orders → ship / cancel per scenario
9. Reports + API console for the reporting and error-path sheets
10. Test plan: Upload Target's workbook → Auto-fill + mark Complete → Export filled workbook → send to Abhiram

## Shopify app scopes
`read_products, read_inventory, write_inventory (only if "deduct Shopify stock" is on), read_locations, read_orders, write_orders (only if "create orders in Shopify" is on), read_fulfillments`

## Useful scripts
- `npm run build`: build web + server
- `npm run db:generate --workspace server`: create a new migration after editing `server/src/db/schema.ts`
- `DISABLE_JOBS=1`: start without background jobs (e.g. a second instance)

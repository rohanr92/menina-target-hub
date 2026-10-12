import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../lib/env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  // Railway's private network (postgres.railway.internal) needs no SSL; set DATABASE_SSL=true for external hosts that require it
  ssl: process.env.DATABASE_SSL === 'true' || /sslmode=require/.test(env.databaseUrl) ? { rejectUnauthorized: false } : undefined,
});
export const db = drizzle(pool, { schema });
export { schema };

export async function runMigrations() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // works from src/db (tsx) and dist/db (compiled)
  const folder = path.resolve(here, '../../drizzle');
  await migrate(db, { migrationsFolder: folder });
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { MIGRATIONS_FOLDER } from './migrations.js';
import { poolConfig } from './pool.js';

/** Applies pending migrations: `pnpm --filter @zvault/api db:migrate`. */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new pg.Pool(poolConfig(env, 1));
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

await main();

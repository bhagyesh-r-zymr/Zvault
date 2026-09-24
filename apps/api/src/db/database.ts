import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

/** Any Drizzle Postgres database: node-postgres in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');

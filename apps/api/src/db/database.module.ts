import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, PG_POOL } from './database.js';
import * as schema from './schema.js';

class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ENV],
      // The pool connects lazily, on the first query.
      useFactory: (env: Env) =>
        new pg.Pool({
          connectionString: env.DATABASE_URL,
          ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
          max: 10,
        }),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => drizzle(pool, { schema }),
    },
    PoolCloser,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}

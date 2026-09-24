import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { ENV } from '../src/config/config.module.js';
import { loadEnv } from '../src/config/env.js';
import { DATABASE, PG_POOL, type Database } from '../src/db/database.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrations.js';
import * as schema from '../src/db/schema.js';
import { Mailer } from '../src/mail/mailer.js';
import { MemoryMailer } from '../src/mail/memory.mailer.js';

export interface Harness {
  app: INestApplication;
  server: Parameters<typeof request>[0];
  db: Database;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

/** Boots the real app on an in-process PGlite Postgres with the migrations applied. */
export async function createHarness(): Promise<Harness> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const mailer = new MemoryMailer();
  const env = loadEnv({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:1420' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(Mailer)
    .useValue(mailer)
    // Tests share one client IP; rate limits are covered separately.
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: () =>
        Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
    })
    .compile();

  const app = configureApp(moduleRef.createNestApplication(), env);
  await app.init();
  return {
    app,
    server: app.getHttpServer() as Harness['server'],
    db: db as unknown as Database,
    mailer,
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

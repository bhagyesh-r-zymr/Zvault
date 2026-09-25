import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { EncryptedBlob } from '@zvault/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { ENV } from '../src/config/config.module.js';
import { loadEnv } from '../src/config/env.js';
import { DATABASE, PG_POOL, type Database } from '../src/db/database.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrations.js';
import { SessionStore } from '../src/devices/session.store.js';
import * as schema from '../src/db/schema.js';
import { Mailer } from '../src/mail/mailer.js';
import { SHARE_CLOCK } from '../src/sharing/clock.js';
import { MemoryMailer } from '../src/mail/memory.mailer.js';

export interface Harness {
  app: INestApplication;
  server: Parameters<typeof request>[0];
  db: Database;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Replaces the sharing clock, so tests can move time forward. */
  clock?: () => Date;
  /** Keep the real rate limits, keyed on `X-Forwarded-For`. */
  rateLimits?: boolean;
}

/** Boots the real app on an in-process PGlite Postgres with the migrations applied. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const mailer = new MemoryMailer();
  const env = loadEnv({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:1420' });

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(Mailer)
    .useValue(mailer);
  if (options.clock) builder = builder.overrideProvider(SHARE_CLOCK).useValue(options.clock);
  if (!options.rateLimits) {
    // Tests share one client IP; rate limits are covered separately.
    builder = builder.overrideProvider(ThrottlerStorage).useValue({
      increment: () =>
        Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
    });
  }
  const moduleRef = await builder.compile();

  const nest = moduleRef.createNestApplication();
  if (options.rateLimits) {
    // Lets each test pick its client IP, so limits apply per test.
    (nest.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      true,
    );
  }
  const app = configureApp(nest, env);
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

let accountCount = 0;

/** A bare account row with a live session; returns headers that authenticate as it. */
export async function signedInAccount(
  h: Harness,
  email = `account-${++accountCount}-${Date.now()}@example.com`,
): Promise<{ id: string; headers: { Authorization: string } }> {
  const [row] = await h.db
    .insert(schema.accounts)
    .values({
      email,
      secretKeyId: 'TESTKEY',
      kdf: { alg: 'argon2id', memoryKib: 65536, iterations: 3, parallelism: 1, salt: 'AAAA' },
      srpVerifier: Buffer.alloc(384, 1),
      encryptedKeyset: {
        v: 1,
        alg: 'xchacha20poly1305',
        kid: 'keyset',
        nonce: 'A'.repeat(32),
        ct: 'AAAA',
      } as EncryptedBlob,
    })
    .returning({ id: schema.accounts.id });
  const { token } = await h.app
    .get(SessionStore)
    .issue(row!.id, { name: 'Test Mac', platform: 'macos', appVersion: '0.1.0' });
  return { id: row!.id, headers: { Authorization: `Bearer ${token}` } };
}

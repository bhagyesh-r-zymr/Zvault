import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ItemConflictResponse,
  ItemRecord,
  ListVaultsResponse,
  SyncItemsResponse,
  type PutItemRequest,
} from '@zvault/shared';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64url');
const blob = (kid: string, bytes: number, fill = 7) => ({
  v: 1,
  alg: 'xchacha20poly1305',
  kid,
  nonce: b64(24, fill),
  ct: b64(bytes, fill),
});
const itemBody = (
  vaultId: string,
  itemId: string,
  baseRevision: number,
  fill = 7,
): PutItemRequest =>
  ({
    baseRevision,
    encryptedKey: blob(vaultId, 48, fill),
    encryptedData: blob(itemId, 272, fill),
  }) as PutItemRequest;

describe('Vault API (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const alice = 'user-alice';
  const bob = 'user-bob';
  const as = (user: string) => ({ 'x-test-user': user });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Stands in for the auth layer, which attaches the verified account.
    app.use((req: Request & { user?: { id: string } }, _res: Response, next: NextFunction) => {
      const id = req.header('x-test-user');
      if (id) req.user = { id };
      next();
    });
    configureApp(app, loadEnv({ NODE_ENV: 'test' }));
    await app.init();
    server = app.getHttpServer() as typeof server;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createVault(user: string): Promise<string> {
    const id = randomUUID();
    await request(server)
      .post('/v1/vaults')
      .set(as(user))
      .send({ id, encryptedKey: blob('account', 48), encryptedMeta: blob(id, 272) })
      .expect(201);
    return id;
  }

  it('requires an authenticated account', async () => {
    await request(server).get('/v1/vaults').expect(401);
  });

  it('creates and lists only the caller’s vaults', async () => {
    const mine = await createVault(alice);
    await createVault(bob);
    const res = await request(server).get('/v1/vaults').set(as(alice)).expect(200);
    const ids = ListVaultsResponse.parse(res.body).vaults.map((v) => v.id);
    expect(ids).toContain(mine);
    expect(ids).toHaveLength(1);
  });

  it('rejects a vault id that is already taken', async () => {
    const id = await createVault(alice);
    await request(server)
      .post('/v1/vaults')
      .set(as(bob))
      .send({ id, encryptedKey: blob('account', 48), encryptedMeta: blob(id, 272) })
      .expect(409);
  });

  it('creates, edits, deletes and syncs an item', async () => {
    const vault = await createVault(alice);
    const item = randomUUID();
    const url = `/v1/vaults/${vault}/items/${item}`;

    const created = ItemRecord.parse(
      (
        await request(server)
          .put(url)
          .set(as(alice))
          .send(itemBody(vault, item, 0))
          .expect(200)
      ).body,
    );
    expect(created).toMatchObject({ revision: 1, seq: 1, deleted: false });

    const edited = ItemRecord.parse(
      (
        await request(server)
          .put(url)
          .set(as(alice))
          .send(itemBody(vault, item, 1, 9))
          .expect(200)
      ).body,
    );
    expect(edited).toMatchObject({ revision: 2, seq: 2 });

    const full = SyncItemsResponse.parse(
      (await request(server).get(`/v1/vaults/${vault}/items`).set(as(alice)).expect(200)).body,
    );
    expect(full.items).toHaveLength(1);
    expect(full.cursor).toBe(2);

    const deleted = ItemRecord.parse(
      (await request(server).delete(`${url}?baseRevision=2`).set(as(alice)).expect(200)).body,
    );
    expect(deleted).toMatchObject({ deleted: true, revision: 3, seq: 3 });
    expect(deleted).not.toHaveProperty('encryptedData');

    const delta = SyncItemsResponse.parse(
      (await request(server).get(`/v1/vaults/${vault}/items?since=2`).set(as(alice)).expect(200))
        .body,
    );
    expect(delta.items.map((i) => i.deleted)).toEqual([true]);
    expect(delta.cursor).toBe(3);
  });

  it('pages through changes', async () => {
    const vault = await createVault(alice);
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await request(server)
        .put(`/v1/vaults/${vault}/items/${id}`)
        .set(as(alice))
        .send(itemBody(vault, id, 0))
        .expect(200);
    }
    const page = SyncItemsResponse.parse(
      (await request(server).get(`/v1/vaults/${vault}/items?limit=2`).set(as(alice)).expect(200))
        .body,
    );
    expect(page).toMatchObject({ cursor: 2, hasMore: true });
    const rest = SyncItemsResponse.parse(
      (
        await request(server)
          .get(`/v1/vaults/${vault}/items?since=2&limit=2`)
          .set(as(alice))
          .expect(200)
      ).body,
    );
    expect(rest).toMatchObject({ cursor: 3, hasMore: false });
  });

  it('returns the current record when an edit is based on a stale revision', async () => {
    const vault = await createVault(alice);
    const item = randomUUID();
    const url = `/v1/vaults/${vault}/items/${item}`;
    await request(server)
      .put(url)
      .set(as(alice))
      .send(itemBody(vault, item, 0))
      .expect(200);
    await request(server)
      .put(url)
      .set(as(alice))
      .send(itemBody(vault, item, 1, 8))
      .expect(200);

    const res = await request(server)
      .put(url)
      .set(as(alice))
      .send(itemBody(vault, item, 1, 9));
    expect(res.status).toBe(409);
    expect(ItemConflictResponse.parse(res.body).current.revision).toBe(2);

    await request(server)
      .put(url)
      .set(as(alice))
      .send(itemBody(vault, item, 0))
      .expect(409);
    await request(server).delete(`${url}?baseRevision=1`).set(as(alice)).expect(409);
  });

  it('hides other accounts’ vaults behind 404', async () => {
    const vault = await createVault(alice);
    const item = randomUUID();
    await request(server).get(`/v1/vaults/${vault}/items`).set(as(bob)).expect(404);
    await request(server)
      .put(`/v1/vaults/${vault}/items/${item}`)
      .set(as(bob))
      .send(itemBody(vault, item, 0))
      .expect(404);
  });

  it('rejects ciphertext bound to a different record', async () => {
    const vault = await createVault(alice);
    const item = randomUUID();
    await request(server)
      .put(`/v1/vaults/${vault}/items/${item}`)
      .set(as(alice))
      .send(itemBody(vault, randomUUID(), 0))
      .expect(400);
  });

  it('rejects malformed ids and bodies', async () => {
    const vault = await createVault(alice);
    await request(server)
      .put(`/v1/vaults/${vault}/items/not-a-uuid`)
      .set(as(alice))
      .send(itemBody(vault, 'not-a-uuid', 0))
      .expect(400);
    await request(server)
      .put(`/v1/vaults/${vault}/items/${randomUUID()}`)
      .set(as(alice))
      .send({ baseRevision: 0, password: 'plaintext' })
      .expect(400);
  });

  it('deletes nothing that does not exist', async () => {
    const vault = await createVault(alice);
    await request(server)
      .delete(`/v1/vaults/${vault}/items/${randomUUID()}?baseRevision=1`)
      .set(as(alice))
      .expect(404);
  });
});

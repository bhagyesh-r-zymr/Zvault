import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ItemHistoryResponse,
  ItemRecord,
  MAX_VERSIONS_PER_RECORD,
  ProjectTrashResponse,
  SecretHistoryResponse,
  SyncProjectResponse,
  VaultTrashResponse,
  type EncryptedBlob,
} from '@zvault/shared';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyGrants, projectEntries, vaultItems } from '../src/db/schema.js';
import { TrashSweeper } from '../src/history/trash-sweeper.js';
import { createHarness, signedInAccount, type Harness } from './harness.js';

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64url');
const blob = (kid: string, bytes = 272, fill = 7) =>
  ({
    v: 1,
    alg: 'xchacha20poly1305',
    kid,
    nonce: b64(24, fill),
    ct: b64(bytes, fill),
  }) as EncryptedBlob;
const wrapped = (kid = 'account', fill = 7) => blob(kid, 48, fill);

type Headers = { Authorization: string };
const DAY = 24 * 60 * 60 * 1000;

describe('History and trash (e2e)', () => {
  let h: Harness;
  let alice: { id: string; headers: Headers };
  let bob: { id: string; headers: Headers };

  beforeAll(async () => {
    h = await createHarness();
    alice = await signedInAccount(h);
    bob = await signedInAccount(h);
  });

  afterAll(async () => {
    await h.close();
  });

  const api = (as: Headers) => ({
    get: (path: string) => request(h.server).get(`/v1${path}`).set(as),
    post: (path: string, body: object) => request(h.server).post(`/v1${path}`).set(as).send(body),
    put: (path: string, body: object) => request(h.server).put(`/v1${path}`).set(as).send(body),
    del: (path: string) => request(h.server).delete(`/v1${path}`).set(as),
  });

  async function createVault(as = alice.headers): Promise<string> {
    const id = randomUUID();
    await api(as)
      .post('/vaults', { id, encryptedKey: wrapped(), encryptedMeta: blob(id) })
      .expect(201);
    return id;
  }

  const itemBody = (vault: string, item: string, baseRevision: number, fill: number) => ({
    baseRevision,
    encryptedKey: wrapped(vault, fill),
    encryptedData: blob(item, 272, fill),
  });

  async function putItem(vault: string, item: string, baseRevision: number, fill: number) {
    const res = await api(alice.headers)
      .put(`/vaults/${vault}/items/${item}`, itemBody(vault, item, baseRevision, fill))
      .expect(200);
    return ItemRecord.parse(res.body);
  }

  async function itemHistory(vault: string, item: string, as = alice.headers) {
    const res = await api(as).get(`/vaults/${vault}/items/${item}/history`).expect(200);
    return ItemHistoryResponse.parse(res.body).versions;
  }

  async function vaultTrash(vault: string) {
    const res = await api(alice.headers).get(`/vaults/${vault}/trash`).expect(200);
    return VaultTrashResponse.parse(res.body).items;
  }

  describe('vault items', () => {
    it('keeps each replaced version, newest first, and restores one by writing it back', async () => {
      const vault = await createVault();
      const item = randomUUID();
      await putItem(vault, item, 0, 1);
      await putItem(vault, item, 1, 2);
      await putItem(vault, item, 2, 3);

      const versions = await itemHistory(vault, item);
      expect(versions.map((v) => v.revision)).toEqual([2, 1]);
      expect(versions[1]).toMatchObject({
        encryptedKey: wrapped(vault, 1),
        encryptedData: blob(item, 272, 1),
      });

      // Restoring revision 1: its ciphertext goes back on top of revision 3.
      const first = versions[1]!;
      const restored = await putItem(vault, item, 3, 1);
      expect(restored).toMatchObject({ revision: 4, encryptedData: first.encryptedData });
      expect((await itemHistory(vault, item)).map((v) => v.revision)).toEqual([3, 2, 1]);
    });

    it('caps how many versions an item keeps', async () => {
      const vault = await createVault();
      const item = randomUUID();
      const writes = MAX_VERSIONS_PER_RECORD + 3;
      for (let rev = 0; rev < writes; rev++) await putItem(vault, item, rev, (rev % 200) + 1);
      const versions = await itemHistory(vault, item);
      expect(versions).toHaveLength(MAX_VERSIONS_PER_RECORD);
      expect(versions[0]!.revision).toBe(writes - 1);
    });

    it('puts deleted items in the trash, restores them and deletes them forever', async () => {
      const vault = await createVault();
      const [kept, restored, purged] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [kept, restored, purged]) await putItem(vault, id, 0, 5);
      await api(alice.headers).del(`/vaults/${vault}/items/${restored}?baseRevision=1`).expect(200);
      await api(alice.headers).del(`/vaults/${vault}/items/${purged}?baseRevision=1`).expect(200);

      const trash = await vaultTrash(vault);
      expect(trash.map((t) => t.id).sort()).toEqual([restored, purged].sort());
      const entry = trash.find((t) => t.id === restored)!;
      expect(entry).toMatchObject({ revision: 2, lastVersion: { revision: 1 } });
      expect(new Date(entry.purgeAt).getTime() - new Date(entry.deletedAt).getTime()).toBe(
        30 * DAY,
      );

      // Restore: write the last version back on top of the tombstone.
      const back = await putItem(vault, restored, entry.revision, 5);
      expect(back).toMatchObject({ deleted: false, revision: 3 });

      await api(alice.headers).del(`/vaults/${vault}/trash/${purged}`).expect(204);
      expect(await vaultTrash(vault)).toEqual([]);
      expect(await itemHistory(vault, purged)).toEqual([]);
      // Only deleted items can be purged, and only once.
      await api(alice.headers).del(`/vaults/${vault}/trash/${kept}`).expect(404);
      await api(alice.headers).del(`/vaults/${vault}/trash/${purged}`).expect(404);
    });

    it('empties the trash', async () => {
      const vault = await createVault();
      const item = randomUUID();
      await putItem(vault, item, 0, 5);
      await api(alice.headers).del(`/vaults/${vault}/items/${item}?baseRevision=1`).expect(200);
      expect(await vaultTrash(vault)).toHaveLength(1);
      await api(alice.headers).del(`/vaults/${vault}/trash`).expect(204);
      expect(await vaultTrash(vault)).toEqual([]);
    });

    it('drops items deleted more than 30 days ago', async () => {
      const vault = await createVault();
      const [old, recent] = [randomUUID(), randomUUID()];
      for (const id of [old, recent]) {
        await putItem(vault, id, 0, 5);
        await api(alice.headers).del(`/vaults/${vault}/items/${id}?baseRevision=1`).expect(200);
      }
      await h.db
        .update(vaultItems)
        .set({ updatedAt: new Date(Date.now() - 31 * DAY) })
        .where(and(eq(vaultItems.vaultId, vault), eq(vaultItems.id, old)));

      expect((await vaultTrash(vault)).map((t) => t.id)).toEqual([recent]);
      await h.app.get(TrashSweeper).sweep();
      expect(await itemHistory(vault, old)).toEqual([]);
      expect(await itemHistory(vault, recent)).toHaveLength(1);
    });

    it('hides other accounts’ history and trash behind 404', async () => {
      const vault = await createVault();
      const item = randomUUID();
      await putItem(vault, item, 0, 5);
      await api(bob.headers).get(`/vaults/${vault}/items/${item}/history`).expect(404);
      await api(bob.headers).get(`/vaults/${vault}/trash`).expect(404);
      await api(bob.headers).del(`/vaults/${vault}/trash`).expect(404);
    });
  });

  describe('project secrets', () => {
    async function createProject() {
      const id = randomUUID();
      const envs = [randomUUID(), randomUUID()] as const;
      await api(alice.headers)
        .post('/projects', {
          id,
          encryptedMeta: blob(id),
          encryptedKey: wrapped(),
          environments: envs.map((e) => ({
            id: e,
            encryptedMeta: blob(e),
            encryptedKey: wrapped(),
          })),
        })
        .expect(201);
      return { id, envs };
    }

    const secretBody = (
      id: string,
      baseRevision: number,
      fill: number,
      values: Record<string, EncryptedBlob | null>,
    ) => ({ baseRevision, encryptedMeta: blob(id, 272, fill), values });

    async function history(project: string, secret: string, as = alice.headers) {
      const res = await api(as).get(`/projects/${project}/secrets/${secret}/history`).expect(200);
      return SecretHistoryResponse.parse(res.body).versions;
    }

    async function trash(project: string, as = alice.headers) {
      const res = await api(as).get(`/projects/${project}/trash`).expect(200);
      return ProjectTrashResponse.parse(res.body).secrets;
    }

    it('keeps each replaced version with every environment’s value', async () => {
      const { id, envs } = await createProject();
      const [dev, prod] = envs;
      const secret = randomUUID();
      const url = `/projects/${id}/secrets/${secret}`;
      await api(alice.headers)
        .put(
          url,
          secretBody(secret, 0, 1, { [dev]: blob(dev, 272, 1), [prod]: blob(prod, 272, 1) }),
        )
        .expect(200);
      await api(alice.headers)
        .put(url, secretBody(secret, 1, 2, { [prod]: blob(prod, 272, 2) }))
        .expect(200);

      const [v1] = await history(id, secret);
      expect(v1).toMatchObject({ revision: 1, encryptedMeta: blob(secret, 272, 1) });
      expect(v1!.values.map((v) => v.encryptedValue)).toEqual(
        [
          { environmentId: dev, encryptedValue: blob(dev, 272, 1) },
          { environmentId: prod, encryptedValue: blob(prod, 272, 1) },
        ]
          .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
          .map((v) => v.encryptedValue),
      );

      // A member sees only the old values of environments they hold a key for.
      await h.db.insert(keyGrants).values([
        { projectId: id, resourceId: id, accountId: bob.id, wrappedKey: wrapped() },
        { projectId: id, resourceId: dev, accountId: bob.id, wrappedKey: wrapped() },
      ]);
      const [bobs] = await history(id, secret, bob.headers);
      expect(bobs!.values.map((v) => v.environmentId)).toEqual([dev]);

      // Deleting an environment forgets its old values too.
      await api(alice.headers)
        .del(`/projects/${id}/environments/${prod}?baseRevision=1`)
        .expect(200);
      const [after] = await history(id, secret);
      expect(after!.values.map((v) => v.environmentId)).toEqual([dev]);
    });

    it('puts deleted secrets in the trash and restores them', async () => {
      const { id, envs } = await createProject();
      const [dev] = envs;
      const secret = randomUUID();
      const url = `/projects/${id}/secrets/${secret}`;
      await api(alice.headers)
        .put(url, secretBody(secret, 0, 3, { [dev]: blob(dev, 272, 3) }))
        .expect(200);
      await api(alice.headers).del(`${url}?baseRevision=1`).expect(200);

      const [entry] = await trash(id);
      expect(entry).toMatchObject({ id: secret, revision: 2, lastVersion: { revision: 1 } });

      const values = Object.fromEntries(
        entry!.lastVersion.values.map((v) => [v.environmentId, v.encryptedValue]),
      );
      await api(alice.headers)
        .put(url, {
          baseRevision: entry!.revision,
          encryptedMeta: entry!.lastVersion.encryptedMeta,
          values,
        })
        .expect(200);
      expect(await trash(id)).toEqual([]);
      const synced = SyncProjectResponse.parse(
        (await api(alice.headers).get(`/projects/${id}/changes`).expect(200)).body,
      ).entries.find((e) => e.id === secret);
      expect(synced).toMatchObject({ deleted: false, revision: 3 });
      if (synced?.type !== 'secret' || synced.deleted) throw new Error('expected a live secret');
      expect(synced.values[0]!.encryptedValue).toEqual(blob(dev, 272, 3));
    });

    it('deletes trashed secrets forever and after 30 days', async () => {
      const { id } = await createProject();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const s of [a, b, c]) {
        await api(alice.headers)
          .put(`/projects/${id}/secrets/${s}`, secretBody(s, 0, 4, {}))
          .expect(200);
        await api(alice.headers).del(`/projects/${id}/secrets/${s}?baseRevision=1`).expect(200);
      }
      await api(bob.headers).get(`/projects/${id}/trash`).expect(404);
      await api(alice.headers).del(`/projects/${id}/trash/${a}`).expect(204);
      await h.db
        .update(projectEntries)
        .set({ updatedAt: new Date(Date.now() - 31 * DAY) })
        .where(and(eq(projectEntries.projectId, id), eq(projectEntries.id, b)));
      expect((await trash(id)).map((t) => t.id)).toEqual([c]);
      await h.app.get(TrashSweeper).sweep();
      expect(await history(id, b)).toEqual([]);

      await api(alice.headers).del(`/projects/${id}/trash`).expect(204);
      expect(await trash(id)).toEqual([]);
      expect(await history(id, c)).toEqual([]);
    });
  });
});

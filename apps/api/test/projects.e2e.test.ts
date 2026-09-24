import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  EntryConflictResponse,
  ListProjectsResponse,
  ProjectEntry,
  ProjectRecord,
  SyncProjectResponse,
  type EncryptedBlob,
} from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyGrants } from '../src/db/schema.js';
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
const wrapped = (kid = 'account') => blob(kid, 48);

type Headers = { Authorization: string };

describe('Projects API (e2e)', () => {
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
    patch: (path: string, body: object) => request(h.server).patch(`/v1${path}`).set(as).send(body),
    del: (path: string) => request(h.server).delete(`/v1${path}`).set(as),
  });

  /** A project with Development, Staging and Production. */
  async function createProject(as = alice.headers) {
    const id = randomUUID();
    const envs = [randomUUID(), randomUUID(), randomUUID()] as const;
    const res = await api(as)
      .post('/projects', {
        id,
        encryptedMeta: blob(id),
        encryptedKey: wrapped(),
        environments: envs.map((e) => ({ id: e, encryptedMeta: blob(e), encryptedKey: wrapped() })),
      })
      .expect(201);
    return { id, envs, record: ProjectRecord.parse(res.body) };
  }

  async function sync(projectId: string, as = alice.headers, since = 0) {
    const res = await api(as).get(`/projects/${projectId}/changes?since=${since}`).expect(200);
    return SyncProjectResponse.parse(res.body);
  }

  const secretBody = (
    id: string,
    baseRevision: number,
    values: Record<string, EncryptedBlob | null>,
  ) => ({
    baseRevision,
    encryptedMeta: blob(id),
    values,
  });

  it('requires a session', async () => {
    await request(h.server).get('/v1/projects').expect(401);
  });

  it('creates a project with its environments and lists it for the owner only', async () => {
    const { id, envs, record } = await createProject();
    expect(record).toMatchObject({ id, revision: 1, owner: true, seq: 3 });

    const mine = ListProjectsResponse.parse(
      (await api(alice.headers).get('/projects').expect(200)).body,
    );
    expect(mine.projects.map((p) => p.id)).toContain(id);
    const theirs = ListProjectsResponse.parse(
      (await api(bob.headers).get('/projects').expect(200)).body,
    );
    expect(theirs.projects.map((p) => p.id)).not.toContain(id);

    const { entries, cursor } = await sync(id);
    expect(cursor).toBe(3);
    expect(entries.map((e) => [e.type, e.id])).toEqual(envs.map((e) => ['environment', e]));
    for (const e of entries) {
      expect(e).toMatchObject({ deleted: false, encryptedKey: { kid: 'account' } });
    }
  });

  it('rejects blobs bound to the wrong record', async () => {
    const id = randomUUID();
    await api(alice.headers)
      .post('/projects', {
        id,
        encryptedMeta: blob(randomUUID()),
        encryptedKey: wrapped(),
        environments: [],
      })
      .expect(400);
    await api(alice.headers)
      .post('/projects', {
        id,
        encryptedMeta: blob(id),
        encryptedKey: wrapped(id),
        environments: [],
      })
      .expect(400);
  });

  it('rejects a taken project id', async () => {
    const { id } = await createProject();
    await api(bob.headers)
      .post('/projects', { id, encryptedMeta: blob(id), encryptedKey: wrapped(), environments: [] })
      .expect(409);
  });

  it('hides other accounts’ projects behind 404', async () => {
    const { id } = await createProject();
    await api(bob.headers).get(`/projects/${id}`).expect(404);
    await api(bob.headers).get(`/projects/${id}/changes`).expect(404);
    const secret = randomUUID();
    await api(bob.headers)
      .put(`/projects/${id}/secrets/${secret}`, secretBody(secret, 0, {}))
      .expect(404);
    await api(bob.headers).del(`/projects/${id}`).expect(404);
  });

  it('stores folders and secrets with a value per environment, and syncs changes', async () => {
    const { id, envs } = await createProject();
    const [dev, , prod] = envs;
    const folder = randomUUID();
    await api(alice.headers)
      .put(`/projects/${id}/folders/${folder}`, { baseRevision: 0, encryptedMeta: blob(folder) })
      .expect(200);

    const secret = randomUUID();
    const url = `/projects/${id}/secrets/${secret}`;
    const created = ProjectEntry.parse(
      (
        await api(alice.headers)
          .put(url, secretBody(secret, 0, { [dev]: blob(dev), [prod]: blob(prod) }))
          .expect(200)
      ).body,
    );
    expect(created).toMatchObject({ type: 'secret', revision: 1, seq: 5 });
    if (created.type !== 'secret' || created.deleted) throw new Error('expected a live secret');
    expect(created.values.map((v) => v.environmentId).sort()).toEqual([dev, prod].sort());

    // Leaving Production out keeps it; null clears Development.
    const edited = ProjectEntry.parse(
      (
        await api(alice.headers)
          .put(url, secretBody(secret, 1, { [dev]: null }))
          .expect(200)
      ).body,
    );
    if (edited.type !== 'secret' || edited.deleted) throw new Error('expected a live secret');
    expect(edited.values.map((v) => v.environmentId)).toEqual([prod]);

    const delta = await sync(id, alice.headers, 3);
    expect(delta.entries.map((e) => [e.type, e.revision])).toEqual([
      ['folder', 1],
      ['secret', 2],
    ]);
    expect(delta).toMatchObject({ cursor: 6, hasMore: false });

    const deleted = ProjectEntry.parse(
      (await api(alice.headers).del(`${url}?baseRevision=2`).expect(200)).body,
    );
    expect(deleted).toMatchObject({ deleted: true, revision: 3 });
    expect(deleted).not.toHaveProperty('encryptedMeta');
  });

  it('pages through changes', async () => {
    const { id } = await createProject();
    const page = SyncProjectResponse.parse(
      (await api(alice.headers).get(`/projects/${id}/changes?limit=2`).expect(200)).body,
    );
    expect(page).toMatchObject({ cursor: 2, hasMore: true });
    expect((await sync(id, alice.headers, 2)).entries).toHaveLength(1);
  });

  it('returns the current entry on a stale write', async () => {
    const { id } = await createProject();
    const secret = randomUUID();
    const url = `/projects/${id}/secrets/${secret}`;
    await api(alice.headers)
      .put(url, secretBody(secret, 0, {}))
      .expect(200);
    await api(alice.headers)
      .put(url, secretBody(secret, 1, {}))
      .expect(200);

    const res = await api(alice.headers).put(url, secretBody(secret, 1, {}));
    expect(res.status).toBe(409);
    expect(EntryConflictResponse.parse(res.body).current.revision).toBe(2);

    // A secret id can't be reused as a folder.
    await api(alice.headers)
      .put(`/projects/${id}/folders/${secret}`, { baseRevision: 2, encryptedMeta: blob(secret) })
      .expect(409);
    // Environments are only created with a key.
    const env = randomUUID();
    await api(alice.headers)
      .put(`/projects/${id}/environments/${env}`, { baseRevision: 0, encryptedMeta: blob(env) })
      .expect(400);
  });

  it('rejects values for unknown environments or sealed for another one', async () => {
    const { id, envs } = await createProject();
    const [dev, staging] = envs;
    const secret = randomUUID();
    const url = `/projects/${id}/secrets/${secret}`;
    await api(alice.headers)
      .put(url, secretBody(secret, 0, { [dev]: blob(staging) }))
      .expect(400);
    const other = randomUUID();
    await api(alice.headers)
      .put(url, secretBody(secret, 0, { [other]: blob(other) }))
      .expect(403);
  });

  it('drops an environment’s values and key when it is deleted', async () => {
    const { id, envs } = await createProject();
    const [dev, staging] = envs;
    const secret = randomUUID();
    await api(alice.headers)
      .put(
        `/projects/${id}/secrets/${secret}`,
        secretBody(secret, 0, { [dev]: blob(dev), [staging]: blob(staging) }),
      )
      .expect(200);
    await api(alice.headers)
      .del(`/projects/${id}/environments/${staging}?baseRevision=1`)
      .expect(200);

    const { entries } = await sync(id);
    const s = entries.find((e) => e.id === secret);
    if (s?.type !== 'secret' || s.deleted) throw new Error('expected a live secret');
    expect(s.values.map((v) => v.environmentId)).toEqual([dev]);
    await api(alice.headers)
      .put(`/projects/${id}/secrets/${secret}`, secretBody(secret, 1, { [staging]: blob(staging) }))
      .expect(403);
  });

  it('shows a member only the environments whose keys they hold', async () => {
    const { id, envs } = await createProject();
    const [dev, , prod] = envs;
    const secret = randomUUID();
    await api(alice.headers)
      .put(
        `/projects/${id}/secrets/${secret}`,
        secretBody(secret, 0, { [dev]: blob(dev), [prod]: blob(prod) }),
      )
      .expect(200);

    // What team access will do: grant Bob the project key and Development only.
    await h.db.insert(keyGrants).values([
      { projectId: id, resourceId: id, accountId: bob.id, wrappedKey: wrapped() },
      { projectId: id, resourceId: dev, accountId: bob.id, wrappedKey: wrapped() },
    ]);

    const project = ProjectRecord.parse(
      (await api(bob.headers).get(`/projects/${id}`).expect(200)).body,
    );
    expect(project.owner).toBe(false);

    const { entries } = await sync(id, bob.headers);
    const keys = Object.fromEntries(
      entries
        .filter((e) => e.type === 'environment' && !e.deleted)
        .map((e) => [e.id, 'encryptedKey' in e ? e.encryptedKey : undefined]),
    );
    expect(keys[dev]).not.toBeNull();
    expect(keys[prod]).toBeNull();
    const s = entries.find((e) => e.id === secret);
    if (s?.type !== 'secret' || s.deleted) throw new Error('expected a live secret');
    expect(s.values.map((v) => v.environmentId)).toEqual([dev]);

    // Bob can edit the secret and its Development value, not Production.
    const url = `/projects/${id}/secrets/${secret}`;
    await api(bob.headers)
      .put(url, secretBody(secret, 1, { [prod]: blob(prod) }))
      .expect(403);
    await api(bob.headers)
      .put(url, secretBody(secret, 1, { [dev]: blob(dev, 272, 9) }))
      .expect(200);
    const after = (await sync(id)).entries.find((e) => e.id === secret);
    if (after?.type !== 'secret' || after.deleted) throw new Error('expected a live secret');
    expect(after.values).toHaveLength(2);

    // Structure is the owner's.
    const folder = randomUUID();
    await api(bob.headers)
      .put(`/projects/${id}/folders/${folder}`, { baseRevision: 0, encryptedMeta: blob(folder) })
      .expect(403);
    await api(bob.headers)
      .patch(`/projects/${id}`, { baseRevision: 1, encryptedMeta: blob(id) })
      .expect(403);
    await api(bob.headers).del(`/projects/${id}`).expect(403);
  });

  it('renames with a revision check and deletes a project', async () => {
    const { id } = await createProject();
    const renamed = ProjectRecord.parse(
      (
        await api(alice.headers)
          .patch(`/projects/${id}`, { baseRevision: 1, encryptedMeta: blob(id, 272, 9) })
          .expect(200)
      ).body,
    );
    expect(renamed.revision).toBe(2);
    await api(alice.headers)
      .patch(`/projects/${id}`, { baseRevision: 1, encryptedMeta: blob(id) })
      .expect(409);

    await api(alice.headers).del(`/projects/${id}`).expect(204);
    await api(alice.headers).get(`/projects/${id}`).expect(404);
  });
});

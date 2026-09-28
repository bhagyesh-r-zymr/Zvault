import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ListTokensResponse,
  TokenChangesResponse,
  TokenSessionResponse,
  TokenView,
  type EncryptedBlob,
} from '@zvault/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTokens, environmentAccess, organizations } from '../src/db/schema.js';
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
const errorOf = (res: { body: unknown }) => (res.body as { error?: string }).error;

describe('Agent tokens (e2e)', () => {
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

  const api = (as: Headers | Record<string, never>) => ({
    get: (path: string) => request(h.server).get(`/v1${path}`).set(as),
    post: (path: string, body: object) => request(h.server).post(`/v1${path}`).set(as).send(body),
    put: (path: string, body: object) => request(h.server).put(`/v1${path}`).set(as).send(body),
    del: (path: string) => request(h.server).delete(`/v1${path}`).set(as),
  });

  /** A project with Development and Production, and one secret set in both. */
  async function project() {
    const id = randomUUID();
    const dev = randomUUID();
    const prod = randomUUID();
    await api(alice.headers)
      .post('/projects', {
        id,
        encryptedMeta: blob(id),
        encryptedKey: wrapped(),
        environments: [dev, prod].map((e) => ({
          id: e,
          encryptedMeta: blob(e),
          encryptedKey: wrapped(),
        })),
      })
      .expect(201);
    const secret = randomUUID();
    await api(alice.headers)
      .put(`/projects/${id}/secrets/${secret}`, {
        baseRevision: 0,
        encryptedMeta: blob(secret),
        values: { [dev]: blob(dev, 272, 1), [prod]: blob(prod, 272, 2) },
      })
      .expect(200);
    return { id, dev, prod, secret };
  }

  function newToken(envs: string[], days = 30) {
    const id = randomUUID();
    const auth = randomBytes(32);
    const body = {
      id,
      name: 'GitHub Actions',
      verifier: createHash('sha256').update(auth).digest('base64url'),
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      encryptedProjectKey: wrapped('agent-token'),
      environments: envs.map((environmentId) => ({
        environmentId,
        keyVersion: 1,
        encryptedKey: wrapped('agent-token'),
      })),
    };
    const bearer = { Authorization: `Bearer ${id}.${auth.toString('base64url')}` };
    return { id, body, bearer };
  }

  it('issues a token that reads only its environment, without a session', async () => {
    const p = await project();
    const t = newToken([p.prod]);
    const created = await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    expect(TokenView.parse(created.body)).toMatchObject({
      id: t.id,
      name: 'GitHub Actions',
      environmentIds: [p.prod],
      lastUsedAt: null,
      stale: false,
    });

    const session = TokenSessionResponse.parse(
      (await api(t.bearer).get('/token').expect(200)).body,
    );
    expect(session.project.id).toBe(p.id);
    expect(session.environments.map((e) => e.environmentId)).toEqual([p.prod]);

    const changes = TokenChangesResponse.parse(
      (await api(t.bearer).get('/token/changes').expect(200)).body,
    );
    const secret = changes.entries.find((e) => e.id === p.secret);
    expect(secret && !secret.deleted && secret.type === 'secret' && secret.values).toEqual([
      expect.objectContaining({ environmentId: p.prod }),
    ]);
    for (const e of changes.entries) {
      if (e.type === 'environment' && !e.deleted) expect(e.encryptedKey).toBeNull();
    }

    const [row] = await h.db.select().from(agentTokens).where(eq(agentTokens.id, t.id));
    expect(row?.lastUsedAt).not.toBeNull();
    // The server keeps only the verifier.
    expect(JSON.stringify(row)).not.toContain(t.bearer.Authorization.split('.')[1]);
  });

  it('rejects wrong, unknown and malformed tokens alike', async () => {
    const p = await project();
    const t = newToken([p.dev]);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    const wrongKey = { Authorization: `Bearer ${t.id}.${b64(32, 9)}` };
    const unknown = { Authorization: `Bearer ${randomUUID()}.${b64(32, 9)}` };
    for (const as of [wrongKey, unknown, { Authorization: 'Bearer nope' }, alice.headers]) {
      const res = await api(as).get('/token').expect(401);
      expect(errorOf(res)).toBe('invalid_token');
    }
    await request(h.server).get('/v1/token').expect(401);
  });

  it('stops working when revoked or expired', async () => {
    const p = await project();
    const t = newToken([p.dev]);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    await api(t.bearer).get('/token').expect(200);
    await api(alice.headers).del(`/projects/${p.id}/tokens/${t.id}`).expect(204);
    await api(t.bearer).get('/token').expect(401);

    const e = newToken([p.dev]);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, e.body).expect(201);
    await h.db
      .update(agentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentTokens.id, e.id));
    expect(errorOf(await api(e.bearer).get('/token').expect(401))).toBe('token_expired');
    // Listing drops expired tokens.
    const list = ListTokensResponse.parse(
      (await api(alice.headers).get(`/projects/${p.id}/tokens`).expect(200)).body,
    );
    expect(list.tokens.map((x) => x.id)).not.toContain(e.id);
  });

  it('is stale after its environment key is rotated', async () => {
    const p = await project();
    const t = newToken([p.dev]);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    const [org] = await h.db
      .insert(organizations)
      .values({ name: 'Acme', createdBy: alice.id })
      .returning();
    await h.db
      .insert(environmentAccess)
      .values({ environmentId: p.dev, projectId: p.id, orgId: org!.id, keyVersion: 2 });
    expect(errorOf(await api(t.bearer).get('/token').expect(409))).toBe('token_stale');
    const list = ListTokensResponse.parse(
      (await api(alice.headers).get(`/projects/${p.id}/tokens`).expect(200)).body,
    );
    expect(list.tokens.find((x) => x.id === t.id)?.stale).toBe(true);
  });

  it('stops working when its environment is deleted', async () => {
    const p = await project();
    const t = newToken([p.prod, p.dev]);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    await api(alice.headers)
      .del(`/projects/${p.id}/environments/${p.dev}?baseRevision=1`)
      .expect(200);
    expect(errorOf(await api(t.bearer).get('/token').expect(401))).toBe(
      'token_environment_deleted',
    );
  });

  it('checks who may issue, list and revoke, and what a token may hold', async () => {
    const p = await project();
    const t = newToken([p.dev]);
    // Non-members can't see the project at all.
    await api(bob.headers).post(`/projects/${p.id}/tokens`, t.body).expect(404);
    await api(bob.headers).get(`/projects/${p.id}/tokens`).expect(404);

    // Keys that aren't wrapped for the token, an environment the creator
    // doesn't hold, a stale key version, a lifetime over a year.
    await api(alice.headers)
      .post(`/projects/${p.id}/tokens`, { ...t.body, encryptedProjectKey: wrapped() })
      .expect(400);
    await api(alice.headers)
      .post(`/projects/${p.id}/tokens`, newToken([randomUUID()]).body)
      .expect(403);
    const old = newToken([p.dev]);
    old.body.environments[0]!.keyVersion = 2;
    await api(alice.headers).post(`/projects/${p.id}/tokens`, old.body).expect(409);
    await api(alice.headers)
      .post(`/projects/${p.id}/tokens`, newToken([p.dev], 400).body)
      .expect(400);
    await api(alice.headers)
      .post(`/projects/${p.id}/tokens`, newToken([p.dev, p.dev]).body)
      .expect(400);

    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(201);
    await api(alice.headers).post(`/projects/${p.id}/tokens`, t.body).expect(409);
    await api(bob.headers).del(`/projects/${p.id}/tokens/${t.id}`).expect(404);
    await api(t.bearer).get('/token').expect(200);
  });
});

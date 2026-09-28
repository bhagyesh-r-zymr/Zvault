import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ActivityPageResponse,
  EncryptedBlob,
  EnvironmentAccess,
  OrgDetail,
  ProjectAccessResponse,
  type AccessLevel,
  type MemberKeyWrap,
} from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts } from '../src/db/schema.js';
import { SessionStore } from '../src/devices/session.store.js';
import { createHarness, type Harness } from './harness.js';

/** Deterministic stand-ins for X25519 public keys and sealed boxes. */
const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString('base64url');
const pub = (fill: number) => b64(32, fill);
const blob = (kid: string, bytes = 64, fill = 7) =>
  ({
    v: 1,
    alg: 'xchacha20poly1305',
    kid,
    nonce: b64(24, fill),
    ct: b64(bytes, fill),
  }) as EncryptedBlob;

interface User {
  id: string;
  email: string;
  token: string;
  key: string;
}

describe('Team activity log (e2e)', () => {
  let h: Harness;
  let sessions: SessionStore;
  let n = 0;

  beforeAll(async () => {
    h = await createHarness();
    sessions = h.app.get(SessionStore);
  });

  afterAll(async () => {
    await h.close();
  });

  async function user(name: string): Promise<User> {
    const email = `${name}-${++n}@example.com`;
    const [row] = await h.db
      .insert(accounts)
      .values({
        email,
        secretKeyId: 'TESTKEY',
        kdf: { alg: 'argon2id', memoryKib: 65536, iterations: 3, parallelism: 1, salt: 'AAAA' },
        srpVerifier: Buffer.alloc(384, 1),
        encryptedKeyset: blob('keyset'),
      })
      .returning({ id: accounts.id });
    const { token } = await sessions.issue(row!.id, {
      name: 'Mac',
      platform: 'macos',
      appVersion: '0.1.0',
    });
    return { id: row!.id, email, token, key: pub(n) };
  }

  const as = (u: User) => ({ Authorization: `Bearer ${u.token}` });
  const api = () => request(h.server);

  const wrap = (to: User, by: User, toKey = to.key): MemberKeyWrap =>
    ({
      recipientId: to.id,
      recipientPublicKey: toKey,
      wrapperPublicKey: by.key,
      ephemeralPublicKey: pub(0xee),
      blob: blob('member-key-wrap', 48, 2),
    }) as MemberKeyWrap;

  /** An org owned by `owner` with `members` invited and joined. */
  async function org(owner: User, ...members: User[]): Promise<string> {
    const res = await api()
      .post('/v1/orgs')
      .set(as(owner))
      .send({ name: 'Acme', publicKey: owner.key })
      .expect(201);
    const orgId = OrgDetail.parse(res.body).id;
    for (const m of members) {
      await api()
        .post(`/v1/orgs/${orgId}/members`)
        .set(as(owner))
        .send({ email: m.email })
        .expect(201);
      await api().post(`/v1/orgs/${orgId}/join`).set(as(m)).send({ publicKey: m.key }).expect(200);
    }
    return orgId;
  }

  /** A project with Development and Production, owned by `owner` and shared with `orgId`. */
  async function project(owner: User, orgId: string) {
    const id = randomUUID();
    const [dev, prod] = [randomUUID(), randomUUID()];
    await api()
      .post('/v1/projects')
      .set(as(owner))
      .send({
        id,
        encryptedMeta: blob(id),
        encryptedKey: blob('account', 48),
        environments: [dev, prod].map((e) => ({
          id: e,
          encryptedMeta: blob(e),
          encryptedKey: blob('account', 48),
        })),
      })
      .expect(201);
    const linked = await api()
      .put(`/v1/access/projects/${id}/org`)
      .set(as(owner))
      .send({ orgId })
      .expect(200);
    expect(ProjectAccessResponse.parse(linked.body).environments.map((e) => e.id)).toEqual(
      expect.arrayContaining([dev, prod]),
    );
    return { id, dev, prod };
  }

  const grant = (
    by: User,
    envId: string,
    principal: { type: 'account' | 'group' | 'agent'; id: string },
    level: AccessLevel,
    expiresAt: string | null = null,
  ) =>
    api()
      .put(`/v1/access/environments/${envId}/grants`)
      .set(as(by))
      .send({ principal, level, expiresAt });

  const detail = async (u: User, envId: string) =>
    EnvironmentAccess.parse(
      (await api().get(`/v1/access/environments/${envId}`).set(as(u)).expect(200)).body,
    );
  const envWraps = (by: User, envId: string, keyVersion: number, wraps: MemberKeyWrap[]) =>
    api().post(`/v1/access/environments/${envId}/keys`).set(as(by)).send({ keyVersion, wraps });
  const projectWraps = (by: User, projectId: string, wraps: MemberKeyWrap[]) =>
    api().post(`/v1/access/projects/${projectId}/keys`).set(as(by)).send({ wraps });
  const putSecret = (u: User, projectId: string, id: string, rev: number, values: object) =>
    api()
      .put(`/v1/projects/${projectId}/secrets/${id}`)
      .set(as(u))
      .send({ baseRevision: rev, encryptedMeta: blob(id), values });

  /** Gives `m` the project key and the current key of each environment in `envs`. */
  async function handKeys(by: User, m: User, projectId: string, envs: string[]) {
    await projectWraps(by, projectId, [wrap(m, by)]).expect(204);
    for (const e of envs) {
      const { keyVersion } = await detail(by, e);
      await envWraps(by, e, keyVersion, [wrap(m, by)]).expect(204);
    }
  }

  const activity = async (u: User, projectId: string, query = '') =>
    ActivityPageResponse.parse(
      (await api().get(`/v1/projects/${projectId}/activity${query}`).set(as(u)).expect(200)).body,
    );
  const report = (u: User, projectId: string, events: object[]) =>
    api().post(`/v1/projects/${projectId}/activity`).set(as(u)).send({ events });

  it('records changes, grants and device reports, newest first', async () => {
    const alice = await user('alice');
    const ben = await user('ben');
    const orgId = await org(alice, ben);
    const p = await project(alice, orgId);
    const secret = randomUUID();

    await putSecret(alice, p.id, secret, 0, {
      [p.dev]: blob(p.dev),
      [p.prod]: blob(p.prod),
    }).expect(200);
    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'use').expect(200);
    await handKeys(alice, ben, p.id, [p.dev]);

    // Ben holds the Development key, so he can report using it but not Production.
    await report(ben, p.id, [
      { action: 'secret.viewed', secretId: secret, environmentId: p.dev },
      { action: 'secret.copied', secretId: secret, environmentId: p.dev },
    ]).expect(204);
    await report(ben, p.id, [
      { action: 'secret.viewed', secretId: secret, environmentId: p.prod },
    ]).expect(403);
    await report(ben, p.id, [
      { action: 'secret.viewed', secretId: randomUUID(), environmentId: p.dev },
    ]).expect(404);
    // Only device actions can be reported, with the fields they need.
    await report(ben, p.id, [
      { action: 'secret.updated', secretId: secret, environmentId: p.dev },
    ]).expect(400);
    await report(ben, p.id, [
      { action: 'secret.shared', secretId: secret, environmentId: p.dev },
    ]).expect(400);
    await report(alice, p.id, [
      { action: 'secret.shared', secretId: secret, environmentId: p.prod, share: 'person' },
      {
        action: 'agent.used',
        secretId: secret,
        environmentId: p.prod,
        agent: { name: 'Claude Code', purpose: 'run', verifiedBy: 'touchId' },
      },
    ]).expect(204);

    const { events, hasMore } = await activity(alice, p.id);
    expect(hasMore).toBe(false);
    expect(events.map((e) => [e.action, e.environmentId])).toEqual([
      ['agent.used', p.prod],
      ['secret.shared', p.prod],
      ['secret.copied', p.dev],
      ['secret.viewed', p.dev],
      ['grant.changed', p.dev],
      ['secret.created', p.prod],
      ['secret.created', p.dev],
      ['project.linked', null],
    ]);
    const [used, shared, copied] = events;
    expect(used!.detail.agent).toEqual({
      name: 'Claude Code',
      purpose: 'run',
      verifiedBy: 'touchId',
    });
    expect(shared!.detail.share).toBe('person');
    expect(copied!.actor).toEqual({ type: 'account', id: ben.id, name: ben.email });
    expect(events[4]!.detail).toEqual({
      principal: { type: 'account', id: ben.id, name: ben.email },
      level: 'use',
    });

    // Filter by secret, and page with `before`.
    const forSecret = await activity(alice, p.id, `?secretId=${secret}`);
    expect(forSecret.events).toHaveLength(6);
    const first = await activity(alice, p.id, '?limit=3');
    expect(first.hasMore).toBe(true);
    const next = await activity(alice, p.id, `?limit=3&before=${first.events.at(-1)!.seq}`);
    expect(next.events.map((e) => e.seq)).toEqual(events.slice(3, 6).map((e) => e.seq));
  });

  it('shows the log to owners, admins and managers only', async () => {
    const alice = await user('alice');
    const ben = await user('ben');
    const cara = await user('cara');
    const orgId = await org(alice, ben, cara);
    const p = await project(alice, orgId);
    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'edit').expect(200);
    await handKeys(alice, ben, p.id, [p.dev]);

    await api().get(`/v1/projects/${p.id}/activity`).set(as(ben)).expect(403);
    // Not a member at all: the project doesn't exist for Cara.
    await api().get(`/v1/projects/${p.id}/activity`).set(as(cara)).expect(404);
    await report(cara, p.id, [
      { action: 'secret.viewed', secretId: randomUUID(), environmentId: p.dev },
    ]).expect(404);

    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'manage').expect(200);
    const { events } = await activity(ben, p.id);
    expect(events[0]).toMatchObject({ action: 'grant.changed', detail: { level: 'manage' } });
  });

  it('records deletes and removed grants', async () => {
    const alice = await user('alice');
    const ben = await user('ben');
    const orgId = await org(alice, ben);
    const p = await project(alice, orgId);
    const secret = randomUUID();
    await putSecret(alice, p.id, secret, 0, { [p.dev]: blob(p.dev) }).expect(200);
    await api()
      .delete(`/v1/projects/${p.id}/secrets/${secret}?baseRevision=1`)
      .set(as(alice))
      .expect(200);
    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'use').expect(200);
    await api()
      .delete(`/v1/access/environments/${p.dev}/grants/account/${ben.id}`)
      .set(as(alice))
      .expect(204);
    const { events } = await activity(alice, p.id);
    expect(events.slice(0, 4).map((e) => e.action)).toEqual([
      'grant.removed',
      'grant.changed',
      'secret.deleted',
      'secret.created',
    ]);
    expect(events[2]!.targetId).toBe(secret);
  });
});

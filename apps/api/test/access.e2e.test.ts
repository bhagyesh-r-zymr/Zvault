import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  AccessRequestView,
  EncryptedBlob,
  EnvironmentAccess,
  ListAccessRequestsResponse,
  MyEnvironmentKeysResponse,
  OrgDetail,
  ProjectAccessResponse,
  type AccessLevel,
  type KeyHolderRef,
  type WrappedEnvironmentKey,
} from '@zvault/shared';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, environmentGrants } from '../src/db/schema.js';
import { SessionStore } from '../src/devices/session.store.js';
import { createHarness, type Harness } from './harness.js';

/** Deterministic stand-ins for X25519 public keys and sealed boxes. */
const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString('base64url');
const pub = (fill: number) => b64(32, fill);

interface User {
  id: string;
  email: string;
  token: string;
  key: string;
}

describe('Team access (e2e)', () => {
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
        encryptedKeyset: EncryptedBlob.parse({
          v: 1,
          alg: 'xchacha20poly1305',
          kid: 'keyset',
          nonce: 'A'.repeat(32),
          ct: 'AAAA',
        }),
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

  function wrap(to: KeyHolderRef, toKey: string, by: User): WrappedEnvironmentKey {
    return {
      recipient: to,
      recipientPublicKey: toKey,
      wrapperPublicKey: by.key,
      ephemeralPublicKey: pub(0xee),
      blob: {
        v: 1,
        alg: 'xchacha20poly1305',
        kid: 'env-key-wrap',
        nonce: b64(24, 1),
        ct: b64(48, 2),
      },
    } as WrappedEnvironmentKey;
  }
  const self = (u: User) => wrap({ type: 'account', id: u.id }, u.key, u);

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

  async function environment(owner: User, orgId: string, projectId: string, name: string) {
    const environmentId = randomUUID();
    const res = await api()
      .post('/v1/access/environments')
      .set(as(owner))
      .send({ environmentId, projectId, orgId, name, wrap: self(owner) })
      .expect(201);
    expect(EnvironmentAccess.parse(res.body)).toMatchObject({ keyVersion: 1, myLevel: 'manage' });
    return environmentId;
  }

  async function group(owner: User, orgId: string, name: string, ...members: User[]) {
    const res = await api()
      .post(`/v1/orgs/${orgId}/groups`)
      .set(as(owner))
      .send({ name })
      .expect(201);
    const id = (res.body as { id: string }).id;
    for (const m of members) {
      await api().put(`/v1/orgs/${orgId}/groups/${id}/members/${m.id}`).set(as(owner)).expect(204);
    }
    return id;
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

  it('requires a session', async () => {
    await api().get('/v1/orgs').expect(401);
    await api().get(`/v1/access/environments/${randomUUID()}`).expect(401);
  });

  it('runs members, invites and groups', async () => {
    const [alice, ben, cara] = [await user('alice'), await user('ben'), await user('cara')];
    const orgId = await org(alice);
    await api()
      .post(`/v1/orgs/${orgId}/members`)
      .set(as(alice))
      .send({ email: ben.email })
      .expect(201);
    // Invited but not joined: the org is listed as an invitation, details stay hidden.
    const listed = await api().get('/v1/orgs').set(as(ben)).expect(200);
    expect(listed.body).toEqual({
      orgs: [{ id: orgId, name: 'Acme', role: 'member', status: 'invited' }],
    });
    await api().get(`/v1/orgs/${orgId}`).set(as(ben)).expect(404);
    await api()
      .post(`/v1/orgs/${orgId}/join`)
      .set(as(ben))
      .send({ publicKey: ben.key })
      .expect(200);
    await api()
      .post(`/v1/orgs/${orgId}/join`)
      .set(as(ben))
      .send({ publicKey: ben.key })
      .expect(409);

    // Strangers and plain members can't see or change the org.
    await api().get(`/v1/orgs/${orgId}`).set(as(cara)).expect(404);
    await api().post(`/v1/orgs/${orgId}/groups`).set(as(ben)).send({ name: 'QA' }).expect(403);
    await api()
      .post(`/v1/orgs/${orgId}/members`)
      .set(as(alice))
      .send({ email: 'nobody@example.com' })
      .expect(404);

    const qa = await group(alice, orgId, 'QA', ben);
    await api().post(`/v1/orgs/${orgId}/groups`).set(as(alice)).send({ name: 'QA' }).expect(409);
    const res = await api().get(`/v1/orgs/${orgId}`).set(as(ben)).expect(200);
    const org1 = OrgDetail.parse(res.body);
    expect(org1.members.find((m) => m.accountId === ben.id)).toMatchObject({
      status: 'active',
      publicKey: ben.key,
      groupIds: [qa],
    });

    // The last owner can't leave or be demoted.
    await api().delete(`/v1/orgs/${orgId}/members/${alice.id}`).set(as(alice)).expect(409);
    await api()
      .patch(`/v1/orgs/${orgId}/members/${alice.id}`)
      .set(as(alice))
      .send({ role: 'admin' })
      .expect(409);
  });

  it('wraps the key only to people with standing access and serves it only to them', async () => {
    const [alice, ben, riya] = [await user('alice'), await user('ben'), await user('riya')];
    const orgId = await org(alice, ben, riya);
    const dev = await environment(alice, orgId, randomUUID(), 'Development');
    const backend = await group(alice, orgId, 'Backend', ben);
    await grant(alice, dev, { type: 'group', id: backend }, 'edit').expect(200);

    // Ben has access through Backend but nothing wrapped yet.
    expect((await detail(alice, dev)).pendingWraps).toEqual([
      { recipient: { type: 'account', id: ben.id }, publicKey: ben.key },
    ]);
    expect((await detail(ben, dev)).pendingWraps).toEqual([]);
    const benKeys = await api()
      .get(`/v1/access/environments/${dev}/keys/me`)
      .set(as(ben))
      .expect(200);
    expect(MyEnvironmentKeysResponse.parse(benKeys.body).wraps).toEqual([]);

    const keys = (by: User, body: object) =>
      api().post(`/v1/access/environments/${dev}/keys`).set(as(by)).send(body);
    // Riya has no access; a stale key for Ben; a non-manager wrapping.
    await keys(alice, {
      keyVersion: 1,
      wraps: [wrap({ type: 'account', id: riya.id }, riya.key, alice)],
    }).expect(422);
    await keys(alice, {
      keyVersion: 1,
      wraps: [wrap({ type: 'account', id: ben.id }, pub(0x99), alice)],
    }).expect(409);
    await keys(ben, {
      keyVersion: 1,
      wraps: [wrap({ type: 'account', id: ben.id }, ben.key, ben)],
    }).expect(403);
    await keys(alice, {
      keyVersion: 2,
      wraps: [wrap({ type: 'account', id: ben.id }, ben.key, alice)],
    }).expect(409);
    await keys(alice, {
      keyVersion: 1,
      wraps: [wrap({ type: 'account', id: ben.id }, ben.key, alice)],
    }).expect(204);

    const after = await api()
      .get(`/v1/access/environments/${dev}/keys/me`)
      .set(as(ben))
      .expect(200);
    expect(MyEnvironmentKeysResponse.parse(after.body).wraps).toMatchObject([
      {
        keyVersion: 1,
        wrapperPublicKey: alice.key,
        recipientPublicKey: ben.key,
        wrappedBy: alice.id,
      },
    ]);
    expect((await detail(alice, dev)).pendingWraps).toEqual([]);
    await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(riya)).expect(403);
  });

  it('drops a contractor’s key when their end date passes and asks for rotation', async () => {
    const [alice, ben, riya] = [await user('alice'), await user('ben'), await user('riya')];
    const orgId = await org(alice, ben, riya);
    const dev = await environment(alice, orgId, randomUUID(), 'Development');
    await grant(alice, dev, { type: 'account', id: ben.id }, 'use').expect(200);
    await grant(alice, dev, { type: 'account', id: riya.id }, 'use', '2020-01-01T00:00:00Z').expect(
      422,
    );
    await grant(alice, dev, { type: 'account', id: riya.id }, 'use', '2099-10-31T00:00:00Z').expect(
      200,
    );
    await api()
      .post(`/v1/access/environments/${dev}/keys`)
      .set(as(alice))
      .send({
        keyVersion: 1,
        wraps: [
          wrap({ type: 'account', id: ben.id }, ben.key, alice),
          wrap({ type: 'account', id: riya.id }, riya.key, alice),
        ],
      })
      .expect(204);
    await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(riya)).expect(200);

    // Time passes: the grant lapses.
    await h.db
      .update(environmentGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(eq(environmentGrants.environmentId, dev), eq(environmentGrants.principalId, riya.id)),
      );
    await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(riya)).expect(403);
    const d = await detail(alice, dev);
    expect(d.rotationRequired).toBe(true);

    // Rotation must reach exactly the remaining key holders.
    const rotate = (wraps: WrappedEnvironmentKey[], fromVersion = 1) =>
      api()
        .post(`/v1/access/environments/${dev}/rotate`)
        .set(as(alice))
        .send({ fromVersion, wraps });
    await rotate([self(alice)]).expect(422);
    await rotate([self(alice), wrap({ type: 'account', id: riya.id }, riya.key, alice)]).expect(
      422,
    );
    await rotate([self(alice), wrap({ type: 'account', id: ben.id }, ben.key, alice)], 2).expect(
      409,
    );
    const rotated = await rotate([
      self(alice),
      wrap({ type: 'account', id: ben.id }, ben.key, alice),
    ]).expect(200);
    expect(EnvironmentAccess.parse(rotated.body)).toMatchObject({
      keyVersion: 2,
      rotationRequired: false,
    });

    const benKeys = MyEnvironmentKeysResponse.parse(
      (await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(ben)).expect(200)).body,
    );
    expect(benKeys.keyVersion).toBe(2);
    expect(benKeys.wraps.map((w) => w.keyVersion)).toEqual([2, 1]);
  });

  it('revokes through groups, direct blocks and member removal', async () => {
    const [alice, ben, cara] = [await user('alice'), await user('ben'), await user('cara')];
    const orgId = await org(alice, ben, cara);
    const dev = await environment(alice, orgId, randomUUID(), 'Development');
    const backend = await group(alice, orgId, 'Backend', ben, cara);
    await grant(alice, dev, { type: 'group', id: backend }, 'use').expect(200);
    const all = [
      wrap({ type: 'account', id: ben.id }, ben.key, alice),
      wrap({ type: 'account', id: cara.id }, cara.key, alice),
    ];
    await api()
      .post(`/v1/access/environments/${dev}/keys`)
      .set(as(alice))
      .send({ keyVersion: 1, wraps: all })
      .expect(204);

    // A direct "No access" beats the group.
    await grant(alice, dev, { type: 'account', id: cara.id }, 'none').expect(200);
    await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(cara)).expect(403);
    expect((await detail(alice, dev)).rotationRequired).toBe(true);

    // Leaving the group removes Ben's access too; removing him from the org hides it all.
    await api()
      .delete(`/v1/orgs/${orgId}/groups/${backend}/members/${ben.id}`)
      .set(as(alice))
      .expect(204);
    await api().get(`/v1/access/environments/${dev}/keys/me`).set(as(ben)).expect(403);
    await api().delete(`/v1/orgs/${orgId}/members/${ben.id}`).set(as(alice)).expect(204);
    await api().get(`/v1/access/environments/${dev}`).set(as(ben)).expect(404);
    await api().get(`/v1/orgs/${orgId}`).set(as(ben)).expect(404);
  });

  it('keeps at least one manager and limits who can change grants', async () => {
    const [alice, ben] = [await user('alice'), await user('ben')];
    const orgId = await org(alice, ben);
    const dev = await environment(alice, orgId, randomUUID(), 'Development');
    await grant(alice, dev, { type: 'account', id: alice.id }, 'edit').expect(409);
    await api()
      .delete(`/v1/access/environments/${dev}/grants/account/${alice.id}`)
      .set(as(alice))
      .expect(409);
    await grant(ben, dev, { type: 'account', id: ben.id }, 'manage').expect(403);
    await grant(alice, dev, { type: 'account', id: randomUUID() }, 'use').expect(404);

    await grant(alice, dev, { type: 'account', id: ben.id }, 'manage').expect(200);
    await api()
      .delete(`/v1/access/environments/${dev}/grants/account/${alice.id}`)
      .set(as(alice))
      .expect(204);
    // Alice is still the org owner, so she can still manage grants.
    await grant(alice, dev, { type: 'account', id: alice.id }, 'use').expect(200);
  });

  it('gates "Needs approval" uses behind a manager', async () => {
    const [alice, ben, cara] = [await user('alice'), await user('ben'), await user('cara')];
    const orgId = await org(alice, ben, cara);
    const prod = await environment(alice, orgId, randomUUID(), 'Production');
    await grant(alice, prod, { type: 'account', id: ben.id }, 'needs_approval').expect(200);

    // No standing key, and nothing to wrap to Ben.
    await api().get(`/v1/access/environments/${prod}/keys/me`).set(as(ben)).expect(403);
    expect((await detail(alice, prod)).pendingWraps).toEqual([]);

    const ask = { items: ['zv://zvault/production/postgres/url'], reason: 'npm test' };
    await api()
      .post(`/v1/access/environments/${prod}/requests`)
      .set(as(cara))
      .send(ask)
      .expect(403);
    await api()
      .post(`/v1/access/environments/${prod}/requests`)
      .set(as(alice))
      .send(ask)
      .expect(403);
    const created = AccessRequestView.parse(
      (
        await api()
          .post(`/v1/access/environments/${prod}/requests`)
          .set(as(ben))
          .send(ask)
          .expect(201)
      ).body,
    );
    expect(created).toMatchObject({
      status: 'pending',
      requesterPublicKey: ben.key,
      release: null,
    });

    const pending = ListAccessRequestsResponse.parse(
      (await api().get(`/v1/access/environments/${prod}/requests`).set(as(alice)).expect(200)).body,
    );
    expect(pending.requests.map((r) => r.id)).toEqual([created.id]);
    await api().get(`/v1/access/requests/${created.id}`).set(as(cara)).expect(404);

    const release = {
      approverPublicKey: alice.key,
      ephemeralPublicKey: pub(0xab),
      blob: {
        v: 1,
        alg: 'xchacha20poly1305',
        kid: 'access-release',
        nonce: b64(24, 3),
        ct: b64(64, 4),
      },
    };
    await api()
      .post(`/v1/access/requests/${created.id}/approve`)
      .set(as(ben))
      .send(release)
      .expect(403);
    await api()
      .post(`/v1/access/requests/${created.id}/approve`)
      .set(as(alice))
      .send({ ...release, approverPublicKey: pub(0x77) })
      .expect(409);
    const approved = AccessRequestView.parse(
      (
        await api()
          .post(`/v1/access/requests/${created.id}/approve`)
          .set(as(alice))
          .send(release)
          .expect(200)
      ).body,
    );
    // The approver doesn't get the release back; the requester does.
    expect(approved).toMatchObject({ status: 'approved', decidedBy: alice.id, release: null });
    const mine = AccessRequestView.parse(
      (await api().get(`/v1/access/requests/${created.id}`).set(as(ben)).expect(200)).body,
    );
    expect(mine.release).toEqual(release);
    await api().post(`/v1/access/requests/${created.id}/deny`).set(as(alice)).expect(409);

    const second = AccessRequestView.parse(
      (
        await api()
          .post(`/v1/access/environments/${prod}/requests`)
          .set(as(ben))
          .send(ask)
          .expect(201)
      ).body,
    );
    const denied = await api()
      .post(`/v1/access/requests/${second.id}/deny`)
      .set(as(alice))
      .expect(200);
    expect(AccessRequestView.parse(denied.body).status).toBe('denied');
  });

  it('lists a project as a matrix of groups, people and agents', async () => {
    const [alice, riya, cara] = [await user('alice'), await user('riya'), await user('cara')];
    const orgId = await org(alice, riya);
    const projectId = randomUUID();
    const dev = await environment(alice, orgId, projectId, 'Development');
    const prod = await environment(alice, orgId, projectId, 'Production');
    const managers = await group(alice, orgId, 'Managers', alice);
    const agentRes = await api()
      .post(`/v1/orgs/${orgId}/agents`)
      .set(as(alice))
      .send({ name: 'Claude Code', publicKey: pub(0xcc) })
      .expect(201);
    const agentId = (agentRes.body as { id: string }).id;

    await grant(alice, dev, { type: 'group', id: managers }, 'manage').expect(200);
    await grant(alice, prod, { type: 'group', id: managers }, 'manage').expect(200);
    await grant(
      alice,
      dev,
      { type: 'account', id: riya.id },
      'use',
      '2099-10-31T00:00:00.000Z',
    ).expect(200);
    await grant(alice, dev, { type: 'agent', id: agentId }, 'needs_approval').expect(200);
    // Agents are principals with keys: they show up for wrapping once they hold access.
    await grant(alice, prod, { type: 'agent', id: agentId }, 'use').expect(200);
    expect((await detail(alice, prod)).pendingWraps).toEqual([
      { recipient: { type: 'agent', id: agentId }, publicKey: pub(0xcc) },
    ]);
    await api()
      .delete(`/v1/access/environments/${prod}/grants/agent/${agentId}`)
      .set(as(alice))
      .expect(204);

    await api().get(`/v1/access/projects/${projectId}`).set(as(cara)).expect(404);
    const matrix = ProjectAccessResponse.parse(
      (await api().get(`/v1/access/projects/${projectId}`).set(as(riya)).expect(200)).body,
    );
    expect(matrix.environments.map((e) => e.name)).toEqual(['Development', 'Production']);
    const cells = Object.fromEntries(
      matrix.rows.map((r) => [
        r.name.replace(/-\d+@example\.com$/, ''),
        r.cells.map((c) => c.level),
      ]),
    );
    expect(cells).toEqual({
      Managers: ['manage', 'manage'],
      alice: ['manage', 'manage'],
      riya: ['use', 'none'],
      'Claude Code': ['needs_approval', 'none'],
    });
    const riyaRow = matrix.rows.find((r) => r.principal.id === riya.id)!;
    expect(riyaRow.cells[0]!.expiresAt).toBe('2099-10-31T00:00:00.000Z');

    // Removing the agent drops its grants.
    await api().delete(`/v1/orgs/${orgId}/agents/${agentId}`).set(as(alice)).expect(204);
    const after = ProjectAccessResponse.parse(
      (await api().get(`/v1/access/projects/${projectId}`).set(as(alice)).expect(200)).body,
    );
    expect(after.rows.some((r) => r.principal.type === 'agent')).toBe(false);
  });
});

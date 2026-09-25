import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  AccessRequestView,
  EncryptedBlob,
  EnvironmentAccess,
  ListAccessRequestsResponse,
  MyProjectKeysResponse,
  OrgDetail,
  ProjectAccessResponse,
  SyncProjectResponse,
  type AccessLevel,
  type MemberKeyWrap,
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
  const matrix = async (u: User, projectId: string) =>
    ProjectAccessResponse.parse(
      (await api().get(`/v1/access/projects/${projectId}`).set(as(u)).expect(200)).body,
    );
  const myKeys = async (u: User, projectId: string) =>
    MyProjectKeysResponse.parse(
      (await api().get(`/v1/access/projects/${projectId}/keys/me`).set(as(u)).expect(200)).body,
    );
  const envWraps = (by: User, envId: string, keyVersion: number, wraps: MemberKeyWrap[]) =>
    api().post(`/v1/access/environments/${envId}/keys`).set(as(by)).send({ keyVersion, wraps });
  const projectWraps = (by: User, projectId: string, wraps: MemberKeyWrap[]) =>
    api().post(`/v1/access/projects/${projectId}/keys`).set(as(by)).send({ wraps });
  const sync = async (u: User, projectId: string) =>
    SyncProjectResponse.parse(
      (await api().get(`/v1/projects/${projectId}/changes?since=0`).set(as(u)).expect(200)).body,
    );
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
    expect(h.mailer.lastTo(ben.email)?.subject).toMatch(/invited you to Acme on Zvault$/);
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
    const org1 = OrgDetail.parse(
      (await api().get(`/v1/orgs/${orgId}`).set(as(ben)).expect(200)).body,
    );
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

  it('only lets a project’s owner share it, once', async () => {
    const [alice, ben] = [await user('alice'), await user('ben')];
    const orgId = await org(alice, ben);
    const p = await project(alice, orgId);
    await api().put(`/v1/access/projects/${p.id}/org`).set(as(alice)).send({ orgId }).expect(409);
    await api()
      .put(`/v1/access/projects/${randomUUID()}/org`)
      .set(as(ben))
      .send({ orgId })
      .expect(404);
    // The owner shows up as each environment's first manager.
    const m = await matrix(alice, p.id);
    expect(m.rows).toEqual([
      {
        principal: { type: 'account', id: alice.id },
        name: alice.email,
        cells: [
          { environmentId: m.environments[0]!.id, level: 'manage', expiresAt: null },
          { environmentId: m.environments[1]!.id, level: 'manage', expiresAt: null },
        ],
      },
    ]);
  });

  it('hands keys only to members with access, who then see only those values', async () => {
    const [alice, ben, riya] = [await user('alice'), await user('ben'), await user('riya')];
    const orgId = await org(alice, ben, riya);
    const p = await project(alice, orgId);
    const backend = await group(alice, orgId, 'Backend', ben);
    await grant(alice, p.dev, { type: 'group', id: backend }, 'edit').expect(200);

    // Ben needs the project key and the Development key; nothing is wrapped yet.
    expect((await matrix(alice, p.id)).pendingProjectWraps).toEqual([
      { accountId: ben.id, publicKey: ben.key },
    ]);
    expect((await detail(alice, p.dev)).pendingWraps).toEqual([
      { accountId: ben.id, publicKey: ben.key },
    ]);
    expect((await matrix(ben, p.id)).pendingProjectWraps).toEqual([]);
    await api().get(`/v1/projects/${p.id}`).set(as(ben)).expect(404);

    // Riya has no access; a stale key for Ben; a non-manager wrapping; an old version.
    await projectWraps(alice, p.id, [wrap(riya, alice)]).expect(422);
    await envWraps(alice, p.dev, 1, [wrap(riya, alice)]).expect(422);
    await envWraps(alice, p.dev, 1, [wrap(ben, alice, pub(0x99))]).expect(409);
    await envWraps(ben, p.dev, 1, [wrap(ben, ben)]).expect(403);
    await envWraps(alice, p.dev, 2, [wrap(ben, alice)]).expect(409);
    await envWraps(alice, p.prod, 1, [wrap(ben, alice)]).expect(422);
    await handKeys(alice, ben, p.id, [p.dev]);

    const keys = await myKeys(ben, p.id);
    expect(keys.projectKey).toMatchObject({ recipientId: ben.id, wrapperPublicKey: alice.key });
    const byEnv = Object.fromEntries(keys.environments.map((e) => [e.environmentId, e]));
    expect(byEnv[p.dev]).toMatchObject({ level: 'edit', keyVersion: 1, wrap: { keyVersion: 1 } });
    expect(byEnv[p.prod]).toMatchObject({ level: 'none', wrap: null });

    // The projects API now serves Ben the project, and only Development's key and values.
    await api().get(`/v1/projects/${p.id}`).set(as(ben)).expect(200);
    const secret = randomUUID();
    await putSecret(alice, p.id, secret, 0, {
      [p.dev]: blob(p.dev),
      [p.prod]: blob(p.prod),
    }).expect(200);
    const entries = (await sync(ben, p.id)).entries;
    const envKeys = entries
      .filter((e) => e.type === 'environment' && !e.deleted)
      .map((e) => [e.id, (e as { encryptedKey: EncryptedBlob | null }).encryptedKey?.kid ?? null]);
    expect(Object.fromEntries(envKeys)).toEqual({ [p.dev]: 'member-key-wrap', [p.prod]: null });
    const s = entries.find((e) => e.id === secret) as { values: { environmentId: string }[] };
    expect(s.values.map((v) => v.environmentId)).toEqual([p.dev]);

    // Edit in Development lets Ben write there; Use would not.
    await putSecret(ben, p.id, secret, 1, { [p.dev]: blob(p.dev, 64, 9) }).expect(200);
    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'use').expect(200);
    await putSecret(ben, p.id, secret, 2, { [p.dev]: blob(p.dev, 64, 8) }).expect(403);
    // Structure stays with the owner and org admins.
    const folder = randomUUID();
    await api()
      .put(`/v1/projects/${p.id}/folders/${folder}`)
      .set(as(ben))
      .send({ baseRevision: 0, encryptedMeta: blob(folder) })
      .expect(403);
  });

  it('drops a contractor’s keys when their end date passes, then rotates', async () => {
    const [alice, ben, riya] = [await user('alice'), await user('ben'), await user('riya')];
    const orgId = await org(alice, ben, riya);
    const p = await project(alice, orgId);
    await grant(alice, p.dev, { type: 'account', id: ben.id }, 'use').expect(200);
    await grant(
      alice,
      p.dev,
      { type: 'account', id: riya.id },
      'use',
      '2020-01-01T00:00:00Z',
    ).expect(422);
    await grant(
      alice,
      p.dev,
      { type: 'account', id: riya.id },
      'use',
      '2099-10-31T00:00:00Z',
    ).expect(200);
    await handKeys(alice, ben, p.id, [p.dev]);
    await handKeys(alice, riya, p.id, [p.dev]);
    const secret = randomUUID();
    await putSecret(alice, p.id, secret, 0, { [p.dev]: blob(p.dev) }).expect(200);
    await api().get(`/v1/projects/${p.id}`).set(as(riya)).expect(200);

    // Time passes: the grant lapses, and Riya loses both keys.
    await h.db
      .update(environmentGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(eq(environmentGrants.environmentId, p.dev), eq(environmentGrants.principalId, riya.id)),
      );
    await api().get(`/v1/projects/${p.id}`).set(as(riya)).expect(404);
    expect((await detail(alice, p.dev)).rotationRequired).toBe(true);

    // Rotation must re-seal every value and reach exactly the remaining key holders.
    const rotate = (wraps: MemberKeyWrap[], values: object[], fromVersion = 1) =>
      api()
        .post(`/v1/access/environments/${p.dev}/rotate`)
        .set(as(alice))
        .send({ fromVersion, wraps, values });
    const newValue = { secretId: secret, encryptedValue: blob(p.dev, 64, 5) };
    const holders = [wrap(alice, alice), wrap(ben, alice)];
    await rotate([wrap(alice, alice)], [newValue]).expect(422);
    await rotate([...holders, wrap(riya, alice)], [newValue]).expect(422);
    await rotate(holders, []).expect(409);
    await rotate(holders, [newValue], 2).expect(409);
    await rotate(holders, [{ ...newValue, encryptedValue: blob(p.prod) }]).expect(422);
    const rotated = await rotate(holders, [newValue]).expect(200);
    expect(EnvironmentAccess.parse(rotated.body)).toMatchObject({
      keyVersion: 2,
      rotationRequired: false,
    });

    const benKeys = await myKeys(ben, p.id);
    expect(benKeys.environments.find((e) => e.environmentId === p.dev)).toMatchObject({
      keyVersion: 2,
      wrap: { keyVersion: 2 },
    });
    const s = (await sync(ben, p.id)).entries.find((e) => e.id === secret) as {
      values: { encryptedValue: EncryptedBlob }[];
    };
    expect(s.values[0]!.encryptedValue).toEqual(newValue.encryptedValue);
  });

  it('revokes through groups, direct blocks and member removal', async () => {
    const [alice, ben, cara] = [await user('alice'), await user('ben'), await user('cara')];
    const orgId = await org(alice, ben, cara);
    const p = await project(alice, orgId);
    const backend = await group(alice, orgId, 'Backend', ben, cara);
    await grant(alice, p.dev, { type: 'group', id: backend }, 'use').expect(200);
    await handKeys(alice, ben, p.id, [p.dev]);
    await handKeys(alice, cara, p.id, [p.dev]);

    // A direct "No access" beats the group.
    await grant(alice, p.dev, { type: 'account', id: cara.id }, 'none').expect(200);
    expect((await myKeys(cara, p.id)).environments.every((e) => e.wrap === null)).toBe(true);
    expect((await detail(alice, p.dev)).rotationRequired).toBe(true);

    // Leaving the group removes Ben's key; removing him from the org hides it all.
    await api()
      .delete(`/v1/orgs/${orgId}/groups/${backend}/members/${ben.id}`)
      .set(as(alice))
      .expect(204);
    await api().get(`/v1/projects/${p.id}`).set(as(ben)).expect(404);
    await api().delete(`/v1/orgs/${orgId}/members/${ben.id}`).set(as(alice)).expect(204);
    await api().get(`/v1/access/environments/${p.dev}`).set(as(ben)).expect(404);
    await api().get(`/v1/orgs/${orgId}`).set(as(ben)).expect(404);
  });

  it('limits who can change grants and structure', async () => {
    const [alice, ben, dana] = [await user('alice'), await user('ben'), await user('dana')];
    const orgId = await org(alice, ben, dana);
    const p = await project(alice, orgId);
    await grant(ben, p.dev, { type: 'account', id: ben.id }, 'manage').expect(403);
    await grant(alice, p.dev, { type: 'account', id: randomUUID() }, 'use').expect(404);
    // The owner can't be locked out of their own project.
    await grant(alice, p.dev, { type: 'account', id: alice.id }, 'none').expect(200);
    expect((await detail(alice, p.dev)).myLevel).toBe('manage');

    // Admins can change a shared project's structure; plain members can't.
    await api()
      .patch(`/v1/orgs/${orgId}/members/${dana.id}`)
      .set(as(alice))
      .send({ role: 'admin' })
      .expect(204);
    await handKeys(alice, dana, p.id, []);
    const env = randomUUID();
    await api()
      .put(`/v1/projects/${p.id}/environments/${env}`)
      .set(as(dana))
      .send({ baseRevision: 0, encryptedMeta: blob(env), encryptedKey: blob('account', 48) })
      .expect(200);
    // The new environment is registered with its creator as manager.
    expect((await detail(dana, env)).myLevel).toBe('manage');
    await grant(dana, env, { type: 'account', id: ben.id }, 'edit').expect(200);
    // Deleting it takes its grants with it; members without the project key can't see it.
    await api()
      .delete(`/v1/projects/${p.id}/environments/${env}?baseRevision=1`)
      .set(as(ben))
      .expect(404);
    await api()
      .delete(`/v1/projects/${p.id}/environments/${env}?baseRevision=1`)
      .set(as(dana))
      .expect(200);
    const left = await h.db
      .select()
      .from(environmentGrants)
      .where(eq(environmentGrants.environmentId, env));
    expect(left).toEqual([]);
    await api().get(`/v1/access/environments/${env}`).set(as(dana)).expect(404);
    // Deleting the whole project stays with its owner.
    await api().delete(`/v1/projects/${p.id}`).set(as(dana)).expect(403);
  });

  it('gates "Needs approval" uses behind a manager', async () => {
    const [alice, ben, cara] = [await user('alice'), await user('ben'), await user('cara')];
    const orgId = await org(alice, ben, cara);
    const p = await project(alice, orgId);
    await grant(alice, p.prod, { type: 'account', id: ben.id }, 'needs_approval').expect(200);

    // Ben gets the project key (to read names) but never a standing Production key.
    expect((await matrix(alice, p.id)).pendingProjectWraps.map((w) => w.accountId)).toEqual([
      ben.id,
    ]);
    expect((await detail(alice, p.prod)).pendingWraps).toEqual([]);
    await envWraps(alice, p.prod, 1, [wrap(ben, alice)]).expect(422);

    const ask = { items: ['zv://zvault/production/postgres/url'], reason: 'npm test' };
    const newRequest = (u: User) =>
      api().post(`/v1/access/environments/${p.prod}/requests`).set(as(u)).send(ask);
    await newRequest(cara).expect(403);
    await newRequest(alice).expect(403);
    const created = AccessRequestView.parse((await newRequest(ben).expect(201)).body);
    expect(created).toMatchObject({
      status: 'pending',
      requesterPublicKey: ben.key,
      release: null,
    });

    const pending = ListAccessRequestsResponse.parse(
      (await api().get(`/v1/access/environments/${p.prod}/requests`).set(as(alice)).expect(200))
        .body,
    );
    expect(pending.requests.map((r) => r.id)).toEqual([created.id]);
    await api().get(`/v1/access/requests/${created.id}`).set(as(cara)).expect(404);

    const release = {
      approverPublicKey: alice.key,
      ephemeralPublicKey: pub(0xab),
      blob: blob('access-release', 64, 4),
    };
    const approve = (u: User, body: object) =>
      api().post(`/v1/access/requests/${created.id}/approve`).set(as(u)).send(body);
    await approve(ben, release).expect(403);
    await approve(alice, { ...release, approverPublicKey: pub(0x77) }).expect(409);
    const approved = AccessRequestView.parse((await approve(alice, release).expect(200)).body);
    // The approver doesn't get the release back; the requester does.
    expect(approved).toMatchObject({ status: 'approved', decidedBy: alice.id, release: null });
    const mine = AccessRequestView.parse(
      (await api().get(`/v1/access/requests/${created.id}`).set(as(ben)).expect(200)).body,
    );
    expect(mine.release).toEqual(release);
    await api().post(`/v1/access/requests/${created.id}/deny`).set(as(alice)).expect(409);

    const second = AccessRequestView.parse((await newRequest(ben).expect(201)).body);
    const denied = await api()
      .post(`/v1/access/requests/${second.id}/deny`)
      .set(as(alice))
      .expect(200);
    expect(AccessRequestView.parse(denied.body).status).toBe('denied');
  });

  it('lists a project as a matrix of groups, people and agents', async () => {
    const [alice, riya, cara] = [await user('alice'), await user('riya'), await user('cara')];
    const orgId = await org(alice, riya);
    const p = await project(alice, orgId);
    const managers = await group(alice, orgId, 'Managers', alice);
    const agentRes = await api()
      .post(`/v1/orgs/${orgId}/agents`)
      .set(as(alice))
      .send({ name: 'Claude Code', publicKey: pub(0xcc) })
      .expect(201);
    const agentId = (agentRes.body as { id: string }).id;

    await grant(alice, p.dev, { type: 'group', id: managers }, 'manage').expect(200);
    await grant(alice, p.prod, { type: 'group', id: managers }, 'manage').expect(200);
    await grant(
      alice,
      p.dev,
      { type: 'account', id: riya.id },
      'use',
      '2099-10-31T00:00:00.000Z',
    ).expect(200);
    // Agents ask each time; they never hold a standing key.
    await grant(alice, p.dev, { type: 'agent', id: agentId }, 'use').expect(422);
    await grant(alice, p.dev, { type: 'agent', id: agentId }, 'needs_approval').expect(200);
    await grant(alice, p.prod, { type: 'agent', id: agentId }, 'none').expect(200);

    await api().get(`/v1/access/projects/${p.id}`).set(as(cara)).expect(404);
    const m = await matrix(riya, p.id);
    const devFirst = m.environments[0]!.id === p.dev;
    const cells = Object.fromEntries(
      m.rows.map((r) => {
        const levels = r.cells.map((c) => c.level);
        return [r.name.replace(/-\d+@example\.com$/, ''), devFirst ? levels : levels.reverse()];
      }),
    );
    expect(cells).toEqual({
      Managers: ['manage', 'manage'],
      alice: ['manage', 'manage'],
      riya: ['use', 'none'],
      'Claude Code': ['needs_approval', 'none'],
    });
    const riyaRow = m.rows.find((r) => r.principal.id === riya.id)!;
    expect(riyaRow.cells.find((c) => c.environmentId === p.dev)!.expiresAt).toBe(
      '2099-10-31T00:00:00.000Z',
    );

    // Removing the agent drops its grants.
    await api().delete(`/v1/orgs/${orgId}/agents/${agentId}`).set(as(alice)).expect(204);
    expect((await matrix(alice, p.id)).rows.some((r) => r.principal.type === 'agent')).toBe(false);
  });
});

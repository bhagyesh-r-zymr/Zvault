import 'reflect-metadata';
import {
  EncryptedBlob,
  ListDevicesResponse,
  RevokeSessionsResponse,
  type DeviceInfo,
} from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts } from '../src/db/schema.js';
import { SESSION_IDLE_TTL_MS, SessionStore } from '../src/devices/session.store.js';
import { createHarness, type Harness } from './harness.js';

const mac: DeviceInfo = { name: 'Work MacBook', platform: 'macos', appVersion: '0.1.0' };
const phone: DeviceInfo = { name: 'iPhone', platform: 'ios', appVersion: '0.1.0' };

describe('Devices (e2e)', () => {
  let h: Harness;
  let sessions: SessionStore;
  let accountCount = 0;

  beforeAll(async () => {
    h = await createHarness();
    sessions = h.app.get(SessionStore);
  });

  afterAll(async () => {
    await h.close();
  });

  /** A bare account row; these tests only need its id. */
  async function newAccount(): Promise<string> {
    const [row] = await h.db
      .insert(accounts)
      .values({
        email: `devices-${++accountCount}@example.com`,
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
    return row!.id;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('requires a valid session token', async () => {
    await request(h.server).get('/v1/devices').expect(401);
    await request(h.server)
      .get('/v1/devices')
      .set(auth('x'.repeat(43)))
      .expect(401);
    await request(h.server).get('/v1/devices').set({ Authorization: 'Basic abc' }).expect(401);
  });

  it('lists the user’s own sessions with the current one first and no tokens', async () => {
    const alice = await newAccount();
    const bob = await newAccount();
    const me = await sessions.issue(alice, mac);
    const other = await sessions.issue(alice, phone);
    await sessions.issue(bob, mac);

    const res = await request(h.server).get('/v1/devices').set(auth(me.token)).expect(200);
    const { devices } = ListDevicesResponse.strict().parse(res.body);
    expect(devices.map((d) => [d.id, d.current])).toEqual([
      [me.session.id, true],
      [other.session.id, false],
    ]);
    expect(JSON.stringify(res.body)).not.toContain(me.token);
    expect(JSON.stringify(res.body)).not.toContain(me.session.tokenHash);
  });

  it('revokes one session, which can no longer authenticate', async () => {
    const alice = await newAccount();
    const me = await sessions.issue(alice, mac);
    const other = await sessions.issue(alice, phone);

    await request(h.server)
      .delete(`/v1/devices/${other.session.id}`)
      .set(auth(me.token))
      .expect(204);
    await request(h.server).get('/v1/devices').set(auth(other.token)).expect(401);
    await request(h.server)
      .delete(`/v1/devices/${other.session.id}`)
      .set(auth(me.token))
      .expect(404);
  });

  it('does not let a user revoke someone else’s session', async () => {
    const alice = await sessions.issue(await newAccount(), mac);
    const bob = await sessions.issue(await newAccount(), mac);

    await request(h.server)
      .delete(`/v1/devices/${bob.session.id}`)
      .set(auth(alice.token))
      .expect(404);
    await request(h.server).get('/v1/devices').set(auth(bob.token)).expect(200);
  });

  it('rejects a malformed session id', async () => {
    const me = await sessions.issue(await newAccount(), mac);
    await request(h.server).delete('/v1/devices/not-a-uuid').set(auth(me.token)).expect(400);
  });

  it('revoking the current session signs this device out', async () => {
    const me = await sessions.issue(await newAccount(), mac);
    await request(h.server).delete(`/v1/devices/${me.session.id}`).set(auth(me.token)).expect(204);
    await request(h.server).get('/v1/devices').set(auth(me.token)).expect(401);
  });

  it('revokes every other session but keeps this one', async () => {
    const alice = await newAccount();
    const me = await sessions.issue(alice, mac);
    const a = await sessions.issue(alice, phone);
    const b = await sessions.issue(alice, phone);
    const bob = await sessions.issue(await newAccount(), mac);

    const res = await request(h.server)
      .post('/v1/devices/revoke-others')
      .set(auth(me.token))
      .expect(200);
    expect(RevokeSessionsResponse.parse(res.body).revoked).toBe(2);

    for (const s of [a, b]) {
      await request(h.server).get('/v1/devices').set(auth(s.token)).expect(401);
    }
    await request(h.server).get('/v1/devices').set(auth(bob.token)).expect(200);
    const list = await request(h.server).get('/v1/devices').set(auth(me.token)).expect(200);
    expect(ListDevicesResponse.parse(list.body).devices).toHaveLength(1);
  });

  it('expires sessions that have been idle too long', async () => {
    const alice = await newAccount();
    const past = new Date(Date.now() - SESSION_IDLE_TTL_MS - 24 * 60 * 60 * 1000);
    const stale = await sessions.issue(alice, mac, past);
    await request(h.server).get('/v1/devices').set(auth(stale.token)).expect(401);
  });
});

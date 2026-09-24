import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ListDevicesResponse, RevokeSessionsResponse, type DeviceInfo } from '@zvault/shared';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { SessionStore } from '../src/devices/session.store.js';

const mac: DeviceInfo = { name: 'Work MacBook', platform: 'macos', appVersion: '0.1.0' };
const phone: DeviceInfo = { name: 'iPhone', platform: 'ios', appVersion: '0.1.0' };

describe('Devices (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let sessions: SessionStore;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication(), loadEnv({ NODE_ENV: 'test' }));
    await app.init();
    server = app.getHttpServer() as typeof server;
    sessions = app.get(SessionStore);
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('requires a valid session token', async () => {
    await request(server).get('/v1/devices').expect(401);
    await request(server)
      .get('/v1/devices')
      .set(auth('x'.repeat(43)))
      .expect(401);
    await request(server).get('/v1/devices').set({ Authorization: 'Basic abc' }).expect(401);
  });

  it('lists the user’s own sessions with the current one first and no tokens', async () => {
    const me = await sessions.issue('alice', mac);
    const other = await sessions.issue('alice', phone);
    await sessions.issue('bob', mac);

    const res = await request(server).get('/v1/devices').set(auth(me.token)).expect(200);
    const { devices } = ListDevicesResponse.strict().parse(res.body);
    expect(devices.map((d) => [d.id, d.current])).toEqual([
      [me.session.id, true],
      [other.session.id, false],
    ]);
    expect(JSON.stringify(res.body)).not.toContain(me.token);
    expect(JSON.stringify(res.body)).not.toContain(me.session.tokenHash);
  });

  it('revokes one session, which can no longer authenticate', async () => {
    const me = await sessions.issue('alice', mac);
    const other = await sessions.issue('alice', phone);

    await request(server).delete(`/v1/devices/${other.session.id}`).set(auth(me.token)).expect(204);
    await request(server).get('/v1/devices').set(auth(other.token)).expect(401);
    await request(server).delete(`/v1/devices/${other.session.id}`).set(auth(me.token)).expect(404);
  });

  it('does not let a user revoke someone else’s session', async () => {
    const alice = await sessions.issue('alice', mac);
    const bob = await sessions.issue('bob', mac);

    await request(server)
      .delete(`/v1/devices/${bob.session.id}`)
      .set(auth(alice.token))
      .expect(404);
    await request(server).get('/v1/devices').set(auth(bob.token)).expect(200);
  });

  it('rejects a malformed session id', async () => {
    const me = await sessions.issue('alice', mac);
    await request(server).delete('/v1/devices/not-a-uuid').set(auth(me.token)).expect(400);
  });

  it('revoking the current session signs this device out', async () => {
    const me = await sessions.issue('alice', mac);
    await request(server).delete(`/v1/devices/${me.session.id}`).set(auth(me.token)).expect(204);
    await request(server).get('/v1/devices').set(auth(me.token)).expect(401);
  });

  it('revokes every other session but keeps this one', async () => {
    const me = await sessions.issue('alice', mac);
    const a = await sessions.issue('alice', phone);
    const b = await sessions.issue('alice', phone);
    const bob = await sessions.issue('bob', mac);

    const res = await request(server)
      .post('/v1/devices/revoke-others')
      .set(auth(me.token))
      .expect(200);
    expect(RevokeSessionsResponse.parse(res.body).revoked).toBe(2);

    for (const s of [a, b]) await request(server).get('/v1/devices').set(auth(s.token)).expect(401);
    await request(server).get('/v1/devices').set(auth(bob.token)).expect(200);
    const list = await request(server).get('/v1/devices').set(auth(me.token)).expect(200);
    expect(ListDevicesResponse.parse(list.body).devices).toHaveLength(1);
  });
});

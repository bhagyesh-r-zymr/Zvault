import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  OpenShareLinkResponse,
  OutgoingUserShare,
  ShareLinkList,
  SharingKeyResponse,
  UserShareList,
} from '@zvault/shared';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { SHARE_CLOCK } from '../src/sharing/clock.js';

const b64 = (buf: Buffer) => buf.toString('base64url');
const rand = (n: number) => b64(randomBytes(n));

const blob = (kid: 'share-link' | 'share-box', ctBytes = 64) => ({
  v: 1,
  alg: 'xchacha20poly1305',
  kid,
  nonce: rand(24),
  ct: rand(ctBytes),
});

/** Mirrors what the app derives from a link key: a token and its SHA-256. */
function newLink() {
  const token = randomBytes(32);
  return {
    id: rand(16),
    accessToken: b64(token),
    verifier: b64(createHash('sha256').update(token).digest()),
  };
}

const ALICE = 'user-alice:alice@example.com';
const BOB = 'user-bob:bob@example.com';

describe('Sharing (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let now = new Date('2026-09-24T12:00:00Z');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SHARE_CLOCK)
      .useValue(() => now)
      .compile();
    app = moduleRef.createNestApplication();
    // Lets each test pick its client IP, so the open endpoint's rate limit
    // applies per test rather than across the whole suite.
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      true,
    );
    // Stand-in for the auth layer, which sets request.user on real sessions.
    app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      const header = req.header('x-test-user');
      if (header) {
        const [id, email] = header.split(':');
        req.user = { id, email };
      }
      next();
    });
    configureApp(app, loadEnv({ NODE_ENV: 'test' }));
    await app.init();
    server = app.getHttpServer() as typeof server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    now = new Date(now.getTime() + 60 * 60 * 1000);
  });

  const createLink = (link: ReturnType<typeof newLink>, extra: object = {}) =>
    request(server)
      .post('/v1/shares/links')
      .set('x-test-user', ALICE)
      .send({ id: link.id, verifier: link.verifier, blob: blob('share-link'), ...extra });

  let clientIp = '';
  let clients = 0;
  beforeEach(() => {
    clients++;
    clientIp = `10.0.${clients >> 8}.${clients & 255}`;
  });

  const open = (id: string, accessToken: string) =>
    request(server)
      .post(`/v1/shares/links/${id}/open`)
      .set('x-forwarded-for', clientIp)
      .send({ accessToken });

  describe('links', () => {
    it('requires sign-in to create or list', async () => {
      await request(server).post('/v1/shares/links').send({}).expect(401);
      await request(server).get('/v1/shares/links').expect(401);
    });

    it('opens once by default, then is gone', async () => {
      const link = newLink();
      const created = await createLink(link).expect(201);
      expect(created.body).toMatchObject({ id: link.id, maxViews: 1, status: 'active' });

      const res = await open(link.id, link.accessToken).expect(200);
      const body = OpenShareLinkResponse.parse(res.body);
      expect(body.viewsRemaining).toBe(0);
      expect(res.headers['cache-control']).toBe('no-store');

      await open(link.id, link.accessToken).expect(404);
      const list = ShareLinkList.parse(
        (await request(server).get('/v1/shares/links').set('x-test-user', ALICE)).body,
      );
      expect(list.links.find((l) => l.id === link.id)?.status).toBe('used_up');
    });

    it('enforces the view limit', async () => {
      const link = newLink();
      await createLink(link, { maxViews: 3 }).expect(201);
      for (const remaining of [2, 1, 0]) {
        const res = await open(link.id, link.accessToken).expect(200);
        expect(OpenShareLinkResponse.parse(res.body).viewsRemaining).toBe(remaining);
      }
      await open(link.id, link.accessToken).expect(404);
    });

    it('refuses a wrong access token without counting a view', async () => {
      const link = newLink();
      await createLink(link).expect(201);
      await open(link.id, rand(32)).expect(404);
      await open(link.id, link.accessToken).expect(200);
    });

    it('expires', async () => {
      const link = newLink();
      await createLink(link, { expiresInSeconds: 600, maxViews: 5 }).expect(201);
      now = new Date(now.getTime() + 601 * 1000);
      await open(link.id, link.accessToken).expect(404);
    });

    it('can be revoked by its owner only', async () => {
      const link = newLink();
      await createLink(link, { maxViews: 5 }).expect(201);
      await request(server)
        .delete(`/v1/shares/links/${link.id}`)
        .set('x-test-user', BOB)
        .expect(404);
      await request(server)
        .delete(`/v1/shares/links/${link.id}`)
        .set('x-test-user', ALICE)
        .expect(204);
      await open(link.id, link.accessToken).expect(404);
    });

    it('answers unknown links exactly like refused ones', async () => {
      const res = await open(rand(16), rand(32)).expect(404);
      const refused = newLink();
      await createLink(refused).expect(201);
      const res2 = await open(refused.id, rand(32)).expect(404);
      expect(res.body).toEqual(res2.body);
    });

    it('rejects out-of-policy requests', async () => {
      await createLink(newLink(), { expiresInSeconds: 31 * 24 * 3600 }).expect(400);
      await createLink(newLink(), { maxViews: 0 }).expect(400);
      await createLink(newLink(), { maxViews: 101 }).expect(400);
      await createLink(newLink(), { blob: blob('share-link', 70_000) }).expect(400);
      await createLink(newLink(), { blob: blob('share-box') }).expect(400);
      await createLink({ ...newLink(), verifier: rand(16) }).expect(400);
      await open('not-an-id', rand(32)).expect(400);
    });

    it('rate-limits guessing', async () => {
      const link = newLink();
      await createLink(link, { maxViews: 100 }).expect(201);
      for (let i = 0; i < 10; i++) await open(link.id, rand(32)).expect(404);
      await open(link.id, link.accessToken).expect(429);
    });

    it('refuses a reused id', async () => {
      const link = newLink();
      await createLink(link).expect(201);
      await createLink(link).expect(409);
    });
  });

  describe('user shares', () => {
    const aliceKey = rand(32);
    const bobKey = rand(32);

    beforeAll(async () => {
      await request(server)
        .put('/v1/shares/keys/me')
        .set('x-test-user', ALICE)
        .send({ publicKey: aliceKey })
        .expect(200);
      await request(server)
        .put('/v1/shares/keys/me')
        .set('x-test-user', BOB)
        .send({ publicKey: bobKey })
        .expect(200);
    });

    const share = (extra: object = {}) =>
      request(server)
        .post('/v1/shares/users')
        .set('x-test-user', ALICE)
        .send({
          id: rand(16),
          recipientEmail: 'Bob@Example.com',
          recipientPublicKey: bobKey,
          senderPublicKey: aliceKey,
          ephemeralPublicKey: rand(32),
          blob: blob('share-box'),
          ...extra,
        });

    it('looks up recipients by email, case-insensitively', async () => {
      const res = await request(server)
        .get('/v1/shares/keys')
        .query({ email: 'BOB@example.com' })
        .set('x-test-user', ALICE)
        .expect(200);
      expect(SharingKeyResponse.parse(res.body)).toEqual({
        userId: 'user-bob',
        email: 'bob@example.com',
        publicKey: bobKey,
      });
      await request(server)
        .get('/v1/shares/keys')
        .query({ email: 'nobody@example.com' })
        .set('x-test-user', ALICE)
        .expect(404);
      await request(server).get('/v1/shares/keys').query({ email: 'bob@example.com' }).expect(401);
    });

    it('delivers to the recipient and lets either side remove it', async () => {
      const { id } = OutgoingUserShare.parse((await share().expect(201)).body);

      const bobView = UserShareList.parse(
        (await request(server).get('/v1/shares/users').set('x-test-user', BOB)).body,
      );
      const received = bobView.incoming.find((s) => s.id === id);
      expect(received?.sender).toEqual({
        userId: 'user-alice',
        email: 'alice@example.com',
        publicKey: aliceKey,
      });

      const aliceView = UserShareList.parse(
        (await request(server).get('/v1/shares/users').set('x-test-user', ALICE)).body,
      );
      expect(aliceView.outgoing.map((s) => s.id)).toContain(id);
      expect(aliceView.incoming).toHaveLength(0);

      await request(server).delete(`/v1/shares/users/${id}`).set('x-test-user', BOB).expect(204);
      await request(server).delete(`/v1/shares/users/${id}`).set('x-test-user', ALICE).expect(404);
    });

    it('refuses stale or mismatched keys', async () => {
      await share({ recipientPublicKey: rand(32) }).expect(409);
      await share({ senderPublicKey: rand(32) }).expect(409);
    });

    it('refuses unknown recipients and self-shares', async () => {
      await share({ recipientEmail: 'nobody@example.com' }).expect(404);
      await share({ recipientEmail: 'alice@example.com', recipientPublicKey: aliceKey }).expect(
        422,
      );
    });

    it('hides expired shares', async () => {
      const created = OutgoingUserShare.parse(
        (await share({ expiresInSeconds: 600 }).expect(201)).body,
      );
      now = new Date(now.getTime() + 601 * 1000);
      const bobView = UserShareList.parse(
        (await request(server).get('/v1/shares/users').set('x-test-user', BOB)).body,
      );
      expect(bobView.incoming.map((s) => s.id)).not.toContain(created.id);
    });
  });
});

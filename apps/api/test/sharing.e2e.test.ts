import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import {
  OpenShareLinkResponse,
  OutgoingUserShare,
  ShareLinkList,
  SharingKeyResponse,
  UserShareList,
  type ShareId,
} from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, signedInAccount, type Harness } from './harness.js';

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

describe('Sharing (e2e)', () => {
  let h: Harness;
  let server: Harness['server'];
  let now = new Date('2026-09-24T12:00:00Z');
  let alice: Awaited<ReturnType<typeof signedInAccount>>;
  let bob: Awaited<ReturnType<typeof signedInAccount>>;

  beforeAll(async () => {
    h = await createHarness({ clock: () => now, rateLimits: true });
    server = h.server;
    alice = await signedInAccount(h, 'alice@example.com');
    bob = await signedInAccount(h, 'bob@example.com');
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    now = new Date(now.getTime() + 60 * 60 * 1000);
  });

  // Each test gets its own client IP, so rate limits apply per test rather
  // than across the whole suite.
  let clientIp = '';
  let clients = 0;
  beforeEach(() => {
    clients++;
    clientIp = `10.0.${clients >> 8}.${clients & 255}`;
  });

  const as = (who: { headers: { Authorization: string } }) => ({
    ...who.headers,
    'x-forwarded-for': clientIp,
  });
  const ALICE = () => as(alice);
  const BOB = () => as(bob);

  const createLink = (link: ReturnType<typeof newLink>, extra: object = {}) =>
    request(server)
      .post('/v1/shares/links')
      .set(ALICE())
      .send({ id: link.id, verifier: link.verifier, blob: blob('share-link'), ...extra });

  const open = (id: string, accessToken: string) =>
    request(server)
      .post(`/v1/shares/links/${id}/open`)
      .set('x-forwarded-for', clientIp)
      .send({ accessToken });

  describe('links', () => {
    it('requires sign-in to create or list', async () => {
      await request(server)
        .post('/v1/shares/links')
        .set('x-forwarded-for', clientIp)
        .send({})
        .expect(401);
      await request(server).get('/v1/shares/links').set('x-forwarded-for', clientIp).expect(401);
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
        (await request(server).get('/v1/shares/links').set(ALICE())).body,
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
      await request(server).delete(`/v1/shares/links/${link.id}`).set(BOB()).expect(404);
      await request(server).delete(`/v1/shares/links/${link.id}`).set(ALICE()).expect(204);
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
        .set(ALICE())
        .send({ publicKey: aliceKey })
        .expect(200);
      await request(server)
        .put('/v1/shares/keys/me')
        .set(BOB())
        .send({ publicKey: bobKey })
        .expect(200);
    });

    const share = (extra: object = {}) =>
      request(server)
        .post('/v1/shares/users')
        .set(ALICE())
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
        .set(ALICE())
        .expect(200);
      expect(SharingKeyResponse.parse(res.body)).toEqual({
        userId: bob.id,
        email: 'bob@example.com',
        publicKey: bobKey,
      });
      await request(server)
        .get('/v1/shares/keys')
        .query({ email: 'nobody@example.com' })
        .set(ALICE())
        .expect(404);
      await request(server)
        .get('/v1/shares/keys')
        .query({ email: 'bob@example.com' })
        .set('x-forwarded-for', clientIp)
        .expect(401);
    });

    it('delivers to the recipient and lets either side remove it', async () => {
      const { id } = OutgoingUserShare.parse((await share().expect(201)).body);

      const bobView = UserShareList.parse(
        (await request(server).get('/v1/shares/users').set(BOB())).body,
      );
      const received = bobView.incoming.find((s) => s.id === id);
      expect(received?.sender).toEqual({
        userId: alice.id,
        email: 'alice@example.com',
        publicKey: aliceKey,
      });

      const aliceView = UserShareList.parse(
        (await request(server).get('/v1/shares/users').set(ALICE())).body,
      );
      expect(aliceView.outgoing.map((s) => s.id)).toContain(id);
      expect(aliceView.incoming).toHaveLength(0);

      await request(server).delete(`/v1/shares/users/${id}`).set(BOB()).expect(204);
      await request(server).delete(`/v1/shares/users/${id}`).set(ALICE()).expect(404);
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
        (await request(server).get('/v1/shares/users').set(BOB())).body,
      );
      expect(bobView.incoming.map((s) => s.id)).not.toContain(created.id);
    });
  });

  describe('email-restricted links', () => {
    const CAROL = 'carol@example.com';
    const post = (id: string, action: string, body: object) =>
      request(server)
        .post(`/v1/shares/links/${id}/${action}`)
        .set('x-forwarded-for', clientIp)
        .send(body);
    const codeFor = (to: string) => /\b(\d{6})\b/.exec(h.mailer.lastTo(to)?.text ?? '')?.[1];
    // The code email is sent in the background.
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('opens only after the recipient confirms a listed email', async () => {
      const link = newLink();
      const created = await createLink(link, {
        allowedEmails: [' Carol@Example.com ', 'dave@example.com', 'carol@example.com'],
      }).expect(201);
      expect(created.body).toMatchObject({ allowedEmailCount: 2 });

      const check = await post(link.id, 'check', { accessToken: link.accessToken }).expect(200);
      expect(check.body).toEqual({ emailRequired: true });

      const denied = await post(link.id, 'open', { accessToken: link.accessToken }).expect(403);
      expect(denied.body).toMatchObject({ reason: 'email_required' });

      await post(link.id, 'code', {
        accessToken: link.accessToken,
        email: 'CAROL@example.com',
      }).expect(202);
      await settle();
      const mail = h.mailer.lastTo(CAROL);
      expect(mail?.subject).toContain('alice@example.com');
      expect(mail?.text).not.toContain(link.accessToken);
      const code = codeFor(CAROL);
      expect(code).toMatch(/^\d{6}$/);

      const opened = await post(link.id, 'open', {
        accessToken: link.accessToken,
        email: CAROL,
        code,
      }).expect(200);
      expect(OpenShareLinkResponse.parse(opened.body).viewsRemaining).toBe(0);
      await post(link.id, 'open', { accessToken: link.accessToken, email: CAROL, code }).expect(
        404,
      );
    });

    it('answers unlisted emails the same and emails them nothing', async () => {
      const link = newLink();
      await createLink(link, { allowedEmails: [CAROL] }).expect(201);
      const sent = h.mailer.sent.length;
      const listed = await post(link.id, 'code', { accessToken: link.accessToken, email: CAROL });
      const other = await post(link.id, 'code', {
        accessToken: link.accessToken,
        email: 'mallory@example.com',
      });
      expect(other.status).toBe(listed.status);
      expect(other.body).toEqual(listed.body);
      await settle();
      expect(h.mailer.sent.length).toBe(sent + 1);
      expect(h.mailer.lastTo('mallory@example.com')).toBeUndefined();

      const guess = await post(link.id, 'open', {
        accessToken: link.accessToken,
        email: 'mallory@example.com',
        code: '123456',
      }).expect(403);
      expect(guess.body).toMatchObject({ reason: 'invalid_code' });
    });

    it('spends a code once, and closes it after too many wrong tries', async () => {
      const link = newLink();
      await createLink(link, { allowedEmails: [CAROL], maxViews: 5 }).expect(201);
      await post(link.id, 'code', { accessToken: link.accessToken, email: CAROL }).expect(202);
      await settle();
      const code = codeFor(CAROL)!;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await post(link.id, 'open', {
          accessToken: link.accessToken,
          email: CAROL,
          code: wrong,
        }).expect(403);
      }
      // The right code no longer works: it was closed after five misses.
      await post(link.id, 'open', { accessToken: link.accessToken, email: CAROL, code }).expect(
        403,
      );
    });

    it('expires codes and limits how often they are sent', async () => {
      const link = newLink();
      await createLink(link, { allowedEmails: [CAROL], maxViews: 5 }).expect(201);
      const ask = () => post(link.id, 'code', { accessToken: link.accessToken, email: CAROL });
      await ask().expect(202);
      await settle();
      const first = codeFor(CAROL);
      const sent = h.mailer.sent.length;
      await ask().expect(202); // Within the cooldown: nothing new is sent.
      await settle();
      expect(h.mailer.sent.length).toBe(sent);

      now = new Date(now.getTime() + 11 * 60 * 1000);
      await post(link.id, 'open', {
        accessToken: link.accessToken,
        email: CAROL,
        code: first,
      }).expect(403);
    });

    it('needs the link key for every step', async () => {
      const link = newLink();
      await createLink(link, { allowedEmails: [CAROL] }).expect(201);
      const sent = h.mailer.sent.length;
      await post(link.id, 'check', { accessToken: rand(32) }).expect(404);
      await post(link.id, 'code', { accessToken: rand(32), email: CAROL }).expect(404);
      await post(link.id, 'open', { accessToken: rand(32), email: CAROL, code: '123456' }).expect(
        404,
      );
      await settle();
      expect(h.mailer.sent.length).toBe(sent);
    });

    it('leaves ordinary links open to anyone with the link', async () => {
      const link = newLink();
      const created = await createLink(link).expect(201);
      expect(created.body).toMatchObject({ allowedEmailCount: 0 });
      const check = await post(link.id, 'check', { accessToken: link.accessToken }).expect(200);
      expect(check.body).toEqual({ emailRequired: false });
      await post(link.id, 'open', { accessToken: link.accessToken }).expect(200);
    });

    it('rejects bad email lists', async () => {
      await createLink(newLink(), { allowedEmails: [] }).expect(400);
      await createLink(newLink(), { allowedEmails: ['not-an-email'] }).expect(400);
      const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
      await createLink(newLink(), { allowedEmails: many }).expect(400);
    });

    it('keeps links in Postgres', async () => {
      const link = newLink();
      await createLink(link, { maxViews: 2 }).expect(201);
      const rows = await h.db.query.shareLinks.findFirst({
        where: (t, { eq }) => eq(t.id, link.id as ShareId),
      });
      expect(rows?.verifier).toBeInstanceOf(Buffer);
    });
  });
});

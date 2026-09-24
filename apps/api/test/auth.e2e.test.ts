import {
  ApiError,
  KDF_DEFAULTS,
  ListDevicesResponse,
  LoginSessionResponse,
  LoginStartResponse,
  SessionResponse,
  SignupVerifyResponse,
} from '@zvault/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pad, verifierFor } from '../src/auth/srp.js';
import { accounts, emailVerifications, srpChallenges } from '../src/db/schema.js';
import { createHarness, type Harness } from './harness.js';
import { clientLogin } from './srp-client.js';

const b64 = (b: Buffer) => b.toString('base64url');
const keyset = {
  v: 1,
  alg: 'xchacha20poly1305',
  kid: 'keyset',
  nonce: b64(randomBytes(24)),
  ct: b64(randomBytes(48)),
};

const device = { name: 'Test Mac', platform: 'macos', appVersion: '0.1.0' } as const;

describe('Auth (e2e)', () => {
  let h: Harness;
  let n = 0;
  const freshEmail = () => `user${++n}-${Date.now()}@example.com`;
  const post = (path: string, body: object) =>
    request(h.server).post(`/v1/auth/${path}`).send(body);

  const codeFor = (email: string) => {
    const mail = h.mailer.lastTo(email.trim().toLowerCase());
    return /\b(\d{6})\b/.exec(mail?.text ?? '')?.[1];
  };

  async function verifyEmail(email: string): Promise<string> {
    await post('signup/start', { email }).expect(202);
    const res = await post('signup/verify', { email, code: codeFor(email) }).expect(200);
    return SignupVerifyResponse.parse(res.body).signupToken;
  }

  async function signUp(email: string, x: Buffer, salt = randomBytes(16)) {
    const signupToken = await verifyEmail(email);
    await post('signup/complete', {
      signupToken,
      secretKeyId: 'ABC123',
      kdf: { ...KDF_DEFAULTS, salt: b64(salt) },
      srpVerifier: b64(verifierFor(x)),
      encryptedKeyset: keyset,
    }).expect(201);
    return salt;
  }

  async function logIn(email: string, x: Buffer) {
    const start = LoginStartResponse.parse((await post('login/start', { email }).expect(200)).body);
    const client = clientLogin({
      identity: email.trim().toLowerCase(),
      salt: Buffer.from(start.kdf.salt, 'base64url'),
      x,
      publicB: Buffer.from(start.srpB, 'base64url'),
    });
    const res = await post('login/finish', {
      loginId: start.loginId,
      srpA: b64(client.publicA),
      srpM1: b64(client.m1),
      device,
    });
    return { res, start, client };
  }

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  describe('sign-up', () => {
    it('emails a six-digit code and creates the account once verified', async () => {
      const email = freshEmail();
      const x = randomBytes(32);
      await signUp(email, x);

      const mail = h.mailer.lastTo(email)!;
      expect(mail.subject).toMatch(/^\d{6} is your Zvault verification code$/);
      const [row] = await h.db.select().from(accounts).where(eq(accounts.email, email));
      expect(row?.srpVerifier.equals(verifierFor(x))).toBe(true);
      expect(row?.encryptedKeyset).toEqual(keyset);
    });

    it('stores only an HMAC of the code', async () => {
      const email = freshEmail();
      await post('signup/start', { email }).expect(202);
      const [row] = await h.db
        .select()
        .from(emailVerifications)
        .where(eq(emailVerifications.email, email));
      expect(row?.codeHash.length).toBe(32);
      expect(row?.codeHash.toString('utf8')).not.toContain(codeFor(email));
    });

    it('normalizes the email address', async () => {
      const email = freshEmail();
      const x = randomBytes(32);
      await signUp(`  ${email.toUpperCase()} `, x);
      const { res } = await logIn(email, x);
      expect(res.status).toBe(200);
    });

    it('rejects a wrong code and locks after five attempts', async () => {
      const email = freshEmail();
      await post('signup/start', { email }).expect(202);
      const code = codeFor(email)!;
      const wrong = code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) {
        const res = await post('signup/verify', { email, code: wrong }).expect(400);
        expect(ApiError.parse(res.body).message).toMatch(/incorrect or has expired/);
      }
      await post('signup/verify', { email, code }).expect(400);
    });

    it('rejects an expired code', async () => {
      const email = freshEmail();
      await post('signup/start', { email }).expect(202);
      await h.db
        .update(emailVerifications)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(emailVerifications.email, email));
      await post('signup/verify', { email, code: codeFor(email) }).expect(400);
    });

    it('waits a minute before sending another code', async () => {
      const email = freshEmail();
      await post('signup/start', { email }).expect(202);
      await post('signup/start', { email }).expect(202);
      expect(h.mailer.sent.filter((m) => m.to === email)).toHaveLength(1);
    });

    it('only honours the newest code', async () => {
      const email = freshEmail();
      await post('signup/start', { email }).expect(202);
      const first = codeFor(email)!;
      await h.db
        .update(emailVerifications)
        .set({ createdAt: new Date(Date.now() - 120_000) })
        .where(eq(emailVerifications.email, email));
      await post('signup/start', { email }).expect(202);
      const second = codeFor(email)!;
      if (first !== second) await post('signup/verify', { email, code: first }).expect(400);
      await post('signup/verify', { email, code: second }).expect(200);
    });

    it('does not reveal registered emails, and tells the owner instead', async () => {
      const email = freshEmail();
      await signUp(email, randomBytes(32));
      await h.db
        .update(emailVerifications)
        .set({ createdAt: new Date(Date.now() - 120_000) })
        .where(eq(emailVerifications.email, email));

      await post('signup/start', { email }).expect(202);
      const mail = h.mailer.lastTo(email)!;
      expect(mail.subject).toBe('You already have a Zvault account');
      expect(mail.text).not.toMatch(/\b\d{6}\b/);
    });

    it('spends the sign-up token once', async () => {
      const email = freshEmail();
      const signupToken = await verifyEmail(email);
      const body = {
        signupToken,
        secretKeyId: 'ABC123',
        kdf: { ...KDF_DEFAULTS, salt: b64(randomBytes(16)) },
        srpVerifier: b64(verifierFor(randomBytes(32))),
        encryptedKeyset: keyset,
      };
      await post('signup/complete', body).expect(201);
      await post('signup/complete', body).expect(400);
    });

    it('rejects weak KDF parameters and degenerate verifiers', async () => {
      const email = freshEmail();
      const signupToken = await verifyEmail(email);
      const base = {
        signupToken,
        secretKeyId: 'ABC123',
        kdf: { ...KDF_DEFAULTS, salt: b64(randomBytes(16)) },
        srpVerifier: b64(verifierFor(randomBytes(32))),
        encryptedKeyset: keyset,
      };
      await post('signup/complete', { ...base, kdf: { ...base.kdf, memoryKib: 1024 } }).expect(400);
      await post('signup/complete', { ...base, srpVerifier: b64(pad(1n)) }).expect(400);
      await post('signup/complete', base).expect(201);
    });

    it('validates request bodies', async () => {
      const res = await post('signup/start', { email: 'nope' }).expect(400);
      expect((res.body as { issues: { path: string }[] }).issues[0]?.path).toBe('email');
    });
  });

  describe('login', () => {
    it('logs in with SRP, proves the server, and opens a session', async () => {
      const email = freshEmail();
      const x = randomBytes(32);
      const salt = await signUp(email, x);

      const { res, start, client } = await logIn(email, x);
      expect(res.status).toBe(200);
      expect(start.kdf.salt).toBe(b64(salt));
      const body = LoginSessionResponse.parse(res.body);
      expect(Buffer.from(body.srpM2, 'base64url').equals(client.expectedM2)).toBe(true);
      expect(body.encryptedKeyset).toEqual(keyset);

      const auth = { Authorization: `Bearer ${body.sessionToken}` };
      const me = await request(h.server).get('/v1/auth/session').set(auth).expect(200);
      expect(SessionResponse.parse(me.body).email).toBe(email);
      const devices = await request(h.server).get('/v1/devices').set(auth).expect(200);
      expect(ListDevicesResponse.parse(devices.body).devices).toEqual([
        expect.objectContaining({ device, current: true }),
      ]);

      await request(h.server).post('/v1/auth/logout').set(auth).expect(204);
      await request(h.server).get('/v1/auth/session').set(auth).expect(401);
    });

    it('rejects the wrong password or Secret Key with one generic error', async () => {
      const email = freshEmail();
      await signUp(email, randomBytes(32));
      const { res } = await logIn(email, randomBytes(32));
      expect(res.status).toBe(401);
      expect(ApiError.parse(res.body).message).toBe(
        'Incorrect email, master password or Secret Key.',
      );
    });

    it('lets each challenge be tried only once', async () => {
      const email = freshEmail();
      const x = randomBytes(32);
      await signUp(email, x);
      const { res, start, client } = await logIn(email, x);
      expect(res.status).toBe(200);
      await post('login/finish', {
        loginId: start.loginId,
        srpA: b64(client.publicA),
        srpM1: b64(client.m1),
        device,
      }).expect(401);
    });

    it('rejects an expired challenge', async () => {
      const email = freshEmail();
      const x = randomBytes(32);
      await signUp(email, x);
      const start = LoginStartResponse.parse((await post('login/start', { email })).body);
      await h.db
        .update(srpChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(srpChallenges.id, start.loginId));
      const client = clientLogin({
        identity: email,
        salt: Buffer.from(start.kdf.salt, 'base64url'),
        x,
        publicB: Buffer.from(start.srpB, 'base64url'),
      });
      await post('login/finish', {
        loginId: start.loginId,
        srpA: b64(client.publicA),
        srpM1: b64(client.m1),
        device,
      }).expect(401);
    });

    it('answers unknown emails with a stable decoy', async () => {
      const email = freshEmail();
      const one = LoginStartResponse.parse((await post('login/start', { email }).expect(200)).body);
      const two = LoginStartResponse.parse((await post('login/start', { email }).expect(200)).body);
      expect(one.kdf).toEqual(two.kdf);
      expect(one.srpB).not.toBe(two.srpB);

      const { res } = await logIn(email, randomBytes(32));
      expect(res.status).toBe(401);
      expect(ApiError.parse(res.body).message).toBe(
        'Incorrect email, master password or Secret Key.',
      );
    });

    it('rejects A = 0', async () => {
      const email = freshEmail();
      await signUp(email, randomBytes(32));
      const start = LoginStartResponse.parse((await post('login/start', { email })).body);
      await post('login/finish', {
        loginId: start.loginId,
        srpA: b64(Buffer.alloc(384)),
        srpM1: b64(randomBytes(32)),
        device,
      }).expect(401);
    });

    it('requires a valid bearer token', async () => {
      await request(h.server).get('/v1/auth/session').expect(401);
      await request(h.server)
        .get('/v1/auth/session')
        .set('Authorization', `Bearer ${b64(randomBytes(32))}`)
        .expect(401);
    });
  });
});

import {
  AccountRecoveryStatus,
  ApiError,
  KDF_DEFAULTS,
  LoginFinishResponse,
  LoginStartResponse,
  RecoverCompleteResponse,
  RecoverVerifyResponse,
  RecoveryCodesResponse,
  ReauthenticatedResponse,
  SignupVerifyResponse,
  TotpSetupResponse,
  isTwoFactorRequired,
} from '@zvault/shared';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifierFor } from '../src/auth/srp.js';
import { accountRecoveries, accounts } from '../src/db/schema.js';
import { base32Decode, hotp, timeStep } from '../src/two-factor/totp.js';
import { createHarness, type Harness } from './harness.js';
import { clientLogin } from './srp-client.js';

const b64 = (b: Buffer) => b.toString('base64url');
const blob = (kid: string) => ({
  v: 1,
  alg: 'xchacha20poly1305',
  kid,
  nonce: b64(randomBytes(24)),
  ct: b64(randomBytes(48)),
});
const device = { name: 'Test Mac', platform: 'macos', appVersion: '0.1.0' } as const;
const kdf = () => ({ ...KDF_DEFAULTS, salt: b64(randomBytes(16)) });

/** What the app derives from a recovery code: an auth token and its SHA-256. */
function recoveryCode() {
  const auth = randomBytes(32);
  return {
    auth: b64(auth),
    material: {
      recoveryKeyset: blob('recovery'),
      recoveryVerifier: b64(createHash('sha256').update(auth).digest()),
    },
  };
}

describe('Master password change and account recovery (e2e)', () => {
  let h: Harness;
  let n = 0;
  const send = (method: 'post' | 'put' | 'get', path: string, body?: object, token?: string) => {
    const req = request(h.server)[method](`/v1/${path}`);
    const authed = token ? req.set('Authorization', `Bearer ${token}`) : req;
    return body ? authed.send(body) : authed;
  };
  const post = (path: string, body: object, token?: string) => send('post', path, body, token);
  const codeFor = (email: string) => /\b(\d{6})\b/.exec(h.mailer.lastTo(email)?.text ?? '')?.[1];

  async function signUp(): Promise<{ email: string; x: Buffer }> {
    const email = `recover${++n}-${Date.now()}@example.com`;
    const x = randomBytes(32);
    await post('auth/signup/start', { email }).expect(202);
    const verify = await post('auth/signup/verify', { email, code: codeFor(email) }).expect(200);
    await post('auth/signup/complete', {
      signupToken: SignupVerifyResponse.parse(verify.body).signupToken,
      secretKeyId: 'ABC123',
      kdf: kdf(),
      srpVerifier: b64(verifierFor(x)),
      encryptedKeyset: blob('keyset'),
    }).expect(201);
    return { email, x };
  }

  /** Answers a fresh login challenge for `email` with `x`. */
  async function prove(email: string, x: Buffer) {
    const start = LoginStartResponse.parse(
      (await post('auth/login/start', { email }).expect(200)).body,
    );
    const client = clientLogin({
      identity: email,
      salt: Buffer.from(start.kdf.salt, 'base64url'),
      x,
      publicB: Buffer.from(start.srpB, 'base64url'),
    });
    return {
      proof: { loginId: start.loginId, srpA: b64(client.publicA), srpM1: b64(client.m1) },
      expectedM2: client.expectedM2,
    };
  }

  async function logIn(email: string, x: Buffer) {
    const { proof } = await prove(email, x);
    return await post('auth/login/finish', { ...proof, device });
  }

  async function session(email: string, x: Buffer): Promise<string> {
    const res = await logIn(email, x);
    expect(res.status).toBe(200);
    const body = LoginFinishResponse.parse(res.body);
    if (isTwoFactorRequired(body)) throw new Error('unexpected 2FA');
    return body.sessionToken;
  }

  const sessionWorks = async (token: string) =>
    (await send('get', 'auth/session', undefined, token)).status === 200;

  async function setUpRecovery(email: string, x: Buffer, token: string) {
    const code = recoveryCode();
    const { proof } = await prove(email, x);
    await send('put', 'auth/recovery', { ...proof, ...code.material }, token).expect(200);
    return code;
  }

  async function recoverTo(email: string, auth: string) {
    await post('auth/recover/start', { email }).expect(202);
    const res = await post('auth/recover/verify', {
      email,
      code: codeFor(email),
      recoveryAuth: auth,
    }).expect(200);
    return RecoverVerifyResponse.parse(res.body);
  }

  function completeBody(recoveryToken: string, x: Buffer) {
    return {
      recoveryToken,
      secretKeyId: 'NEWKEY',
      kdf: kdf(),
      srpVerifier: b64(verifierFor(x)),
      encryptedKeyset: blob('keyset'),
      ...recoveryCode().material,
      device,
    };
  }

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  describe('changing the master password', () => {
    it('replaces the verifier and keyset, and signs out the other sessions', async () => {
      const { email, x } = await signUp();
      const current = await session(email, x);
      const other = await session(email, x);

      const x2 = randomBytes(32);
      const newKdf = kdf();
      const newKeyset = blob('keyset');
      const { proof, expectedM2 } = await prove(email, x);
      const res = await post(
        'auth/password',
        { ...proof, kdf: newKdf, srpVerifier: b64(verifierFor(x2)), encryptedKeyset: newKeyset },
        current,
      ).expect(200);
      const { srpM2 } = ReauthenticatedResponse.parse(res.body);
      expect(Buffer.from(srpM2, 'base64url').equals(expectedM2)).toBe(true);

      const [row] = await h.db.select().from(accounts).where(eq(accounts.email, email));
      expect(row?.kdf).toEqual(newKdf);
      expect(row?.encryptedKeyset).toEqual(newKeyset);
      expect(row?.secretKeyId).toBe('ABC123');

      expect((await logIn(email, x)).status).toBe(401);
      expect((await logIn(email, x2)).status).toBe(200);
      expect(await sessionWorks(current)).toBe(true);
      expect(await sessionWorks(other)).toBe(false);
      expect(h.mailer.lastTo(email)?.subject).toBe('Your Zvault master password was changed');
    });

    it('needs a proof of the current master password, not just the session', async () => {
      const { email, x } = await signUp();
      const token = await session(email, x);
      const { proof } = await prove(email, randomBytes(32));
      const body = { kdf: kdf(), srpVerifier: b64(verifierFor(randomBytes(32))) };
      const res = await post(
        'auth/password',
        { ...proof, ...body, encryptedKeyset: blob('keyset') },
        token,
      ).expect(403);
      expect(ApiError.parse(res.body).message).toBe('Incorrect master password.');
      expect((await logIn(email, x)).status).toBe(200);

      // A proof is spent once, and only counts for the account it was made for.
      const other = await signUp();
      const theirs = await prove(other.email, other.x);
      await post(
        'auth/password',
        { ...theirs.proof, ...body, encryptedKeyset: blob('keyset') },
        token,
      ).expect(403);
      const mine = await prove(email, x);
      const change = { ...mine.proof, ...body, encryptedKeyset: blob('keyset') };
      await post('auth/password', change, token).expect(200);
      await post('auth/password', change, token).expect(403);
      await post('auth/password', change).expect(401);
    });
  });

  describe('setting up recovery', () => {
    it('stores the recovery copy after a proof of the master password', async () => {
      const { email, x } = await signUp();
      const token = await session(email, x);
      const status = () => send('get', 'auth/recovery', undefined, token).expect(200);
      expect(AccountRecoveryStatus.parse((await status()).body)).toEqual({
        enabled: false,
        updatedAt: null,
      });

      const { proof: wrong } = await prove(email, randomBytes(32));
      await send('put', 'auth/recovery', { ...wrong, ...recoveryCode().material }, token).expect(
        403,
      );

      const code = await setUpRecovery(email, x, token);
      expect(AccountRecoveryStatus.parse((await status()).body).enabled).toBe(true);
      const [row] = await h.db.select().from(accounts).where(eq(accounts.email, email));
      expect(row?.recoveryKeyset).toEqual(code.material.recoveryKeyset);
      expect(h.mailer.lastTo(email)?.subject).toBe('A Zvault recovery code was set up');

      await setUpRecovery(email, x, token);
      expect(h.mailer.lastTo(email)?.subject).toBe('A Zvault recovery code was replaced');
    });
  });

  describe('recovering an account', () => {
    it('releases the recovery copy for the right codes and resets the account', async () => {
      const { email, x } = await signUp();
      const old = await session(email, x);
      const code = await setUpRecovery(email, x, old);

      const verified = await recoverTo(email, code.auth);
      expect(verified.recoveryKeyset).toEqual(code.material.recoveryKeyset);
      expect(verified.twoFactorRequired).toBe(false);

      const x3 = randomBytes(32);
      const body = completeBody(verified.recoveryToken, x3);
      const res = await post('auth/recover/complete', body).expect(200);
      const done = RecoverCompleteResponse.parse(res.body);

      expect(await sessionWorks(done.sessionToken)).toBe(true);
      expect(await sessionWorks(old)).toBe(false);
      expect((await logIn(email, x)).status).toBe(401);
      expect((await logIn(email, x3)).status).toBe(200);
      const [row] = await h.db.select().from(accounts).where(eq(accounts.email, email));
      expect(row?.secretKeyId).toBe('NEWKEY');
      expect(row?.recoveryKeyset).toEqual(body.recoveryKeyset);
      expect(h.mailer.lastTo(email)?.subject).toBe('Your Zvault account was recovered');

      // The token is single use, and the old recovery code no longer works.
      await post('auth/recover/complete', body).expect(400);
      await h.db
        .update(accountRecoveries)
        .set({ createdAt: new Date(Date.now() - 120_000) })
        .where(eq(accountRecoveries.email, email));
      await post('auth/recover/start', { email }).expect(202);
      await post('auth/recover/verify', {
        email,
        code: codeFor(email),
        recoveryAuth: code.auth,
      }).expect(400);
    });

    it('rejects a wrong recovery code or email code and closes after five tries', async () => {
      const { email, x } = await signUp();
      const code = await setUpRecovery(email, x, await session(email, x));
      await post('auth/recover/start', { email }).expect(202);
      const emailed = codeFor(email)!;
      const wrongEmailCode = emailed === '000000' ? '111111' : '000000';

      const bad = await post('auth/recover/verify', {
        email,
        code: emailed,
        recoveryAuth: b64(randomBytes(32)),
      }).expect(400);
      expect(ApiError.parse(bad.body).message).toMatch(/incorrect/);
      await post('auth/recover/verify', {
        email,
        code: wrongEmailCode,
        recoveryAuth: code.auth,
      }).expect(400);
      for (let i = 0; i < 3; i++) {
        await post('auth/recover/verify', {
          email,
          code: wrongEmailCode,
          recoveryAuth: code.auth,
        }).expect(400);
      }
      // Closed now, even with both codes right.
      await post('auth/recover/verify', { email, code: emailed, recoveryAuth: code.auth }).expect(
        400,
      );
    });

    it('answers the same for every address and emails only real accounts', async () => {
      const { email } = await signUp();
      await post('auth/recover/start', { email }).expect(202);
      expect(h.mailer.lastTo(email)?.subject).toBe('Your Zvault account has no recovery code');
      await post('auth/recover/verify', {
        email,
        code: '123456',
        recoveryAuth: b64(randomBytes(32)),
      }).expect(400);

      const nobody = `nobody${Date.now()}@example.com`;
      await post('auth/recover/start', { email: nobody }).expect(202);
      expect(h.mailer.lastTo(nobody)).toBeUndefined();

      // One code a minute per address.
      const before = h.mailer.sent.length;
      await post('auth/recover/start', { email }).expect(202);
      expect(h.mailer.sent.length).toBe(before);
    });

    it('asks for a 2FA code before resetting an account with 2FA on', async () => {
      const { email, x } = await signUp();
      const token = await session(email, x);
      const setup = TotpSetupResponse.parse(
        (await post('2fa/totp/setup', {}, token).expect(200)).body,
      );
      const secret = base32Decode(setup.secret);
      const confirm = await post(
        '2fa/totp/confirm',
        { code: hotp(secret, timeStep(Date.now())) },
        token,
      ).expect(200);
      const { recoveryCodes } = RecoveryCodesResponse.parse(confirm.body);
      const code = await setUpRecovery(email, x, token);

      const verified = await recoverTo(email, code.auth);
      expect(verified.twoFactorRequired).toBe(true);
      const body = completeBody(verified.recoveryToken, randomBytes(32));
      const missing = await post('auth/recover/complete', body).expect(401);
      expect(missing.body.error).toBe('two_factor_required');
      await post('auth/recover/complete', { ...body, twoFactor: { code: '000000' } }).expect(403);
      await post('auth/recover/complete', {
        ...body,
        twoFactor: { recoveryCode: recoveryCodes[0] },
      }).expect(200);
    });
  });
});

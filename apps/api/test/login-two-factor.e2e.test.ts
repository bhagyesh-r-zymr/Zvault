import {
  ApiError,
  KDF_DEFAULTS,
  LoginFinishResponse,
  LoginStartResponse,
  LoginTwoFactorRequiredResponse,
  LoginTwoFactorResponse,
  RecoveryCodesResponse,
  SignupVerifyResponse,
  TotpSetupResponse,
  TwoFactorStatusResponse,
  isTwoFactorRequired,
} from '@zvault/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifierFor } from '../src/auth/srp.js';
import { hashToken } from '../src/auth/tokens.js';
import { loginTwoFactorChallenges, twoFactor } from '../src/db/schema.js';
import { base32Decode, hotp, timeStep } from '../src/two-factor/totp.js';
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

describe('Login with two-factor authentication (e2e)', () => {
  let h: Harness;
  let n = 0;
  const post = (path: string, body: object, token?: string) => {
    const req = request(h.server).post(`/v1/${path}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  };

  async function signUp(): Promise<{ email: string; x: Buffer }> {
    const email = `tfa${++n}-${Date.now()}@example.com`;
    const x = randomBytes(32);
    await post('auth/signup/start', { email }).expect(202);
    const code = /\b(\d{6})\b/.exec(h.mailer.lastTo(email)?.text ?? '')?.[1];
    const verify = await post('auth/signup/verify', { email, code }).expect(200);
    await post('auth/signup/complete', {
      signupToken: SignupVerifyResponse.parse(verify.body).signupToken,
      secretKeyId: 'ABC123',
      kdf: { ...KDF_DEFAULTS, salt: b64(randomBytes(16)) },
      srpVerifier: b64(verifierFor(x)),
      encryptedKeyset: keyset,
    }).expect(201);
    return { email, x };
  }

  async function passwordStep(email: string, x: Buffer) {
    const start = LoginStartResponse.parse(
      (await post('auth/login/start', { email }).expect(200)).body,
    );
    const client = clientLogin({
      identity: email,
      salt: Buffer.from(start.kdf.salt, 'base64url'),
      x,
      publicB: Buffer.from(start.srpB, 'base64url'),
    });
    const res = await post('auth/login/finish', {
      loginId: start.loginId,
      srpA: b64(client.publicA),
      srpM1: b64(client.m1),
      device,
    }).expect(200);
    return { body: LoginFinishResponse.parse(res.body), client };
  }

  /** Signs up, signs in and turns on 2FA through the real session. */
  async function enrolledUser() {
    const { email, x } = await signUp();
    const { body } = await passwordStep(email, x);
    if (isTwoFactorRequired(body)) throw new Error('2FA should be off for a new account');
    const token = body.sessionToken;
    const setup = TotpSetupResponse.parse(
      (await post('2fa/totp/setup', {}, token).expect(200)).body,
    );
    expect(setup.otpauthUri).toContain(encodeURIComponent(email));
    const secret = base32Decode(setup.secret);
    const confirm = await post(
      '2fa/totp/confirm',
      { code: hotp(secret, timeStep(Date.now())) },
      token,
    ).expect(200);
    const { recoveryCodes } = RecoveryCodesResponse.parse(confirm.body);
    return { email, x, secret, recoveryCodes, token };
  }

  /** The confirm step spent the current time step, so sign-in uses the next one (within the ±1 window). */
  const nextCode = (secret: Buffer) => hotp(secret, timeStep(Date.now()) + 1);

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('manages 2FA through the signed-in session and stores it in Postgres', async () => {
    const { token } = await enrolledUser();
    const status = await request(h.server)
      .get('/v1/2fa')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(TwoFactorStatusResponse.parse(status.body)).toMatchObject({
      totpEnabled: true,
      recoveryCodesRemaining: 10,
    });
    const rows = await h.db.select().from(twoFactor);
    expect(rows.some((r) => r.totpSecret !== null && r.version > 0)).toBe(true);
    await request(h.server).get('/v1/2fa').expect(401);
  });

  it('holds back the session and keyset until a valid code is given', async () => {
    const { email, x, secret } = await enrolledUser();
    const { body, client } = await passwordStep(email, x);

    expect(isTwoFactorRequired(body)).toBe(true);
    const pending = LoginTwoFactorRequiredResponse.parse(body);
    expect(Buffer.from(pending.srpM2, 'base64url').equals(client.expectedM2)).toBe(true);
    expect(body).not.toHaveProperty('sessionToken');
    expect(body).not.toHaveProperty('encryptedKeyset');

    const wrong = await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: '000000' === nextCode(secret) ? '111111' : '000000' },
    }).expect(403);
    expect((wrong.body as { error: string }).error).toBe('invalid_two_factor_code');

    const ok = await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: nextCode(secret) },
    }).expect(200);
    const session = LoginTwoFactorResponse.parse(ok.body);
    expect(session.encryptedKeyset).toEqual(keyset);
    await request(h.server)
      .get('/v1/auth/session')
      .set('Authorization', `Bearer ${session.sessionToken}`)
      .expect(200);

    // The pending login is single-use.
    await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: nextCode(secret) },
    }).expect(401);
  });

  it('accepts a recovery code once', async () => {
    const { email, x, recoveryCodes } = await enrolledUser();
    const first = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    await post('auth/login/two-factor', {
      twoFactorToken: first.twoFactorToken,
      proof: { recoveryCode: recoveryCodes[0] },
    }).expect(200);

    const second = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    await post('auth/login/two-factor', {
      twoFactorToken: second.twoFactorToken,
      proof: { recoveryCode: recoveryCodes[0] },
    }).expect(403);
  });

  it('rejects a replayed TOTP code on a later login', async () => {
    const { email, x, secret } = await enrolledUser();
    const code = nextCode(secret);
    const first = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    await post('auth/login/two-factor', {
      twoFactorToken: first.twoFactorToken,
      proof: { code },
    }).expect(200);
    const second = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    await post('auth/login/two-factor', {
      twoFactorToken: second.twoFactorToken,
      proof: { code },
    }).expect(403);
  });

  it('ends a pending login after too many wrong codes', async () => {
    const { email, x, secret } = await enrolledUser();
    const pending = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    const good = nextCode(secret);
    const bad = good === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) {
      await post('auth/login/two-factor', {
        twoFactorToken: pending.twoFactorToken,
        proof: { code: bad },
      }).expect(403);
    }
    // The fifth wrong code also locks the account's second factor.
    await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: bad },
    }).expect(429);
    const res = await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: good },
    }).expect(401);
    expect(ApiError.parse(res.body).message).toBe('Your sign-in expired. Sign in again.');
  });

  it('expires pending logins', async () => {
    const { email, x, secret } = await enrolledUser();
    const pending = LoginTwoFactorRequiredResponse.parse((await passwordStep(email, x)).body);
    await h.db
      .update(loginTwoFactorChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(loginTwoFactorChallenges.tokenHash, hashToken(pending.twoFactorToken)));
    await post('auth/login/two-factor', {
      twoFactorToken: pending.twoFactorToken,
      proof: { code: nextCode(secret) },
    }).expect(401);
  });

  it('validates the request body', async () => {
    await post('auth/login/two-factor', { twoFactorToken: 'x', proof: { code: '1' } }).expect(400);
  });
});

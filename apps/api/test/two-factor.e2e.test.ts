import 'reflect-metadata';
import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { RecoveryCodesResponse, TotpSetupResponse, TwoFactorStatusResponse } from '@zvault/shared';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { TWO_FACTOR_CLOCK } from '../src/two-factor/clock.js';
import {
  TwoFactorModule,
  TwoFactorService,
  type AuthenticatedUser,
  type AuthenticatedUserResolver,
} from '../src/two-factor/index.js';
import { base32Decode, hotp, timeStep } from '../src/two-factor/totp.js';

/** Stands in for the session layer: trusts an `x-test-user` header. */
@Injectable()
class HeaderResolver implements AuthenticatedUserResolver {
  resolve(req: Request): Promise<AuthenticatedUser | null> {
    const id = req.header('x-test-user');
    return Promise.resolve(id ? { id, email: `${id}@example.com` } : null);
  }
}

describe('2FA (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const clock = { t: 1_800_000_000_000, now: () => clock.t };
  let userSeq = 0;
  let user: string;

  const as = (u: string) => ({
    get: (path: string) => request(server).get(path).set('x-test-user', u),
    post: (path: string, body?: object) =>
      request(server)
        .post(path)
        .set('x-test-user', u)
        .send(body ?? {}),
  });

  async function enroll(u: string): Promise<{ secret: Buffer; recoveryCodes: string[] }> {
    const setup = TotpSetupResponse.parse(
      (await as(u).post('/v1/2fa/totp/setup').expect(200)).body,
    );
    const secret = base32Decode(setup.secret);
    const res = await as(u)
      .post('/v1/2fa/totp/confirm', { code: hotp(secret, timeStep(clock.t)) })
      .expect(200);
    return { secret, recoveryCodes: RecoveryCodesResponse.parse(res.body).recoveryCodes };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
        TwoFactorModule.forRoot({ userResolver: HeaderResolver }),
      ],
    })
      .overrideProvider(TWO_FACTOR_CLOCK)
      .useValue(clock)
      .compile();
    app = configureApp(moduleRef.createNestApplication(), loadEnv({ NODE_ENV: 'test' }));
    await app.init();
    server = app.getHttpServer() as typeof server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    user = `user-${++userSeq}`;
    clock.t += 10 * 60_000;
  });

  it('rejects requests without a session', async () => {
    await request(server).get('/v1/2fa').expect(401);
    await request(server).post('/v1/2fa/totp/setup').expect(401);
  });

  it('enrolls with a QR secret and returns recovery codes once', async () => {
    const before = TwoFactorStatusResponse.parse((await as(user).get('/v1/2fa').expect(200)).body);
    expect(before.totpEnabled).toBe(false);

    const setupRes = await as(user).post('/v1/2fa/totp/setup').expect(200);
    expect(setupRes.headers['cache-control']).toBe('no-store');
    const setup = TotpSetupResponse.parse(setupRes.body);
    const uri = new URL(setup.otpauthUri);
    expect(uri.searchParams.get('secret')).toBe(setup.secret);
    expect(decodeURIComponent(uri.pathname)).toBe(`/Zvault:${user}@example.com`);

    const secret = base32Decode(setup.secret);
    const confirm = await as(user)
      .post('/v1/2fa/totp/confirm', { code: hotp(secret, timeStep(clock.t)) })
      .expect(200);
    const { recoveryCodes } = RecoveryCodesResponse.parse(confirm.body);
    expect(new Set(recoveryCodes).size).toBe(10);

    const after = TwoFactorStatusResponse.parse((await as(user).get('/v1/2fa').expect(200)).body);
    expect(after).toMatchObject({ totpEnabled: true, recoveryCodesRemaining: 10 });

    await as(user).post('/v1/2fa/totp/setup').expect(409);
  });

  it('does not enable 2FA on a wrong code, and expires stale setups', async () => {
    await as(user).post('/v1/2fa/totp/setup').expect(200);
    const wrong = await as(user).post('/v1/2fa/totp/confirm', { code: '000000' });
    expect(wrong.status).toBe(403);
    clock.t += 11 * 60_000;
    await as(user).post('/v1/2fa/totp/confirm', { code: '123456' }).expect(404);
    const status = TwoFactorStatusResponse.parse((await as(user).get('/v1/2fa')).body);
    expect(status.totpEnabled).toBe(false);
  });

  it('validates request bodies', async () => {
    await enroll(user);
    await as(user).post('/v1/2fa/disable', { code: 'abc' }).expect(400);
    await as(user).post('/v1/2fa/disable', {}).expect(400);
  });

  it('lets the login flow verify codes, refusing replays and spent recovery codes', async () => {
    const { secret, recoveryCodes } = await enroll(user);
    const service = app.get(TwoFactorService);
    expect(await service.isEnabled(user)).toBe(true);

    // The enrollment code's step is spent; the next step's code works once.
    await expect(service.verify(user, { code: hotp(secret, timeStep(clock.t)) })).rejects.toThrow();
    clock.t += 30_000;
    const code = hotp(secret, timeStep(clock.t));
    await service.verify(user, { code });
    await expect(service.verify(user, { code })).rejects.toThrow();

    const recoveryCode = recoveryCodes[0]!.toLowerCase();
    await service.verify(user, { recoveryCode: recoveryCodes[0]! });
    await expect(service.verify(user, { recoveryCode })).rejects.toThrow();
    expect((await service.status(user)).recoveryCodesRemaining).toBe(9);
  });

  it('locks after five wrong codes', async () => {
    const { secret } = await enroll(user);
    for (let i = 0; i < 4; i++) {
      await as(user).post('/v1/2fa/disable', { code: '000000' }).expect(403);
    }
    await as(user).post('/v1/2fa/disable', { code: '000000' }).expect(429);
    clock.t += 30_000;
    const valid = hotp(secret, timeStep(clock.t));
    await as(user).post('/v1/2fa/disable', { code: valid }).expect(429);

    clock.t += 16 * 60_000;
    await as(user)
      .post('/v1/2fa/disable', { code: hotp(secret, timeStep(clock.t)) })
      .expect(204);
  });

  it('regenerates recovery codes, invalidating the old set', async () => {
    const { recoveryCodes } = await enroll(user);
    const res = await as(user)
      .post('/v1/2fa/recovery-codes', { recoveryCode: recoveryCodes[0] })
      .expect(200);
    const fresh = RecoveryCodesResponse.parse(res.body).recoveryCodes;
    expect(fresh).not.toContain(recoveryCodes[1]);
    await as(user).post('/v1/2fa/disable', { recoveryCode: recoveryCodes[1] }).expect(403);
    await as(user).post('/v1/2fa/disable', { recoveryCode: fresh[0] }).expect(204);
    const status = TwoFactorStatusResponse.parse((await as(user).get('/v1/2fa')).body);
    expect(status).toEqual({ totpEnabled: false, recoveryCodesRemaining: 0, enabledAt: null });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api.js';
import { mockFetch } from './test/tauri.js';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api', () => {
  it('posts JSON without a body response', async () => {
    const spy = mockFetch({
      'POST /v1/auth/signup/start': () => new Response(null, { status: 204 }),
    });
    await expect(api.signupStart('a@b.co')).resolves.toBeUndefined();
    const [url, init] = spy.mock.calls[0]!;
    expect(url as string).toMatch(/\/v1\/auth\/signup\/start$/);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.co' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends the bearer token and parses a typed response', async () => {
    const spy = mockFetch({
      'GET /v1/auth/session': {
        accountId: '3f1c1d6e-6a0b-4c3a-8d3e-0a7a1a8b9c10',
        email: 'a@b.co',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
    const res = await api.session('tok');
    expect(res.email).toBe('a@b.co');
    const init = spy.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.body).toBeUndefined();
  });

  it('reads the recovery status', async () => {
    mockFetch({ 'GET /v1/auth/recovery': { enabled: false, updatedAt: null } });
    await expect(api.recoveryStatus('t')).resolves.toEqual({ enabled: false, updatedAt: null });
  });

  it('logs out with an explicit POST and no body', async () => {
    const spy = mockFetch({ 'POST /v1/auth/logout': () => new Response(null, { status: 204 }) });
    await api.logout('tok');
    expect(spy.mock.calls[0]![1]!.method).toBe('POST');
  });

  it('hits the expected endpoint for every call', async () => {
    const spy = mockFetch({});
    const kdf = { alg: 'argon2id', memoryKib: 1, iterations: 1, parallelism: 1, salt: 's' };
    const blob = { v: 1, alg: 'xchacha20poly1305', kid: 'k', nonce: 'n', ct: 'c' };
    const any = (x: unknown) => x as never;
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => api.signupVerify('a@b.co', '123456'), 'POST', 'auth/signup/verify'],
      [() => api.signupComplete(any({ kdf, blob })), 'POST', 'auth/signup/complete'],
      [() => api.loginStart('a@b.co'), 'POST', 'auth/login/start'],
      [() => api.loginFinish(any({})), 'POST', 'auth/login/finish'],
      [() => api.loginTwoFactor(any({})), 'POST', 'auth/login/two-factor'],
      [() => api.changePassword('t', any({})), 'POST', 'auth/password'],
      [() => api.setUpRecovery('t', any({})), 'PUT', 'auth/recovery'],
      [() => api.recoverStart('a@b.co'), 'POST', 'auth/recover/start'],
      [() => api.recoverVerify(any({})), 'POST', 'auth/recover/verify'],
      [() => api.recoverComplete(any({})), 'POST', 'auth/recover/complete'],
    ];
    for (const [fn, method, path] of calls) {
      spy.mockClear();
      await expect(fn()).rejects.toBeInstanceOf(ApiRequestError);
      const [url, init] = spy.mock.calls[0]!;
      expect(url as string).toMatch(new RegExp(`/v1/${path}$`));
      expect(init?.method).toBe(method);
    }
  });

  it('turns a network failure into a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(api.loginStart('a@b.co')).rejects.toMatchObject({
      status: 0,
      message: "Can't reach the Zvault server. Check your connection.",
    });
  });

  it('reads the standard error shape and the machine code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(json(400, { statusCode: 400, message: 'Bad code', error: 'bad_code' })),
    );
    const err = await api.signupVerify('a@b.co', '1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 400, message: 'Bad code', code: 'bad_code' });
  });

  it('falls back to a message field, then to a generic message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(409, { message: 'Taken' })));
    await expect(api.loginStart('a@b.co')).rejects.toMatchObject({ message: 'Taken' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('oops', { status: 500 })));
    await expect(api.loginStart('a@b.co')).rejects.toMatchObject({
      status: 500,
      message: 'Request failed (500)',
    });
  });

  it('explains rate limiting unless the server gave a code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(429, {})));
    await expect(api.loginStart('a@b.co')).rejects.toMatchObject({
      status: 429,
      message: 'Too many attempts. Wait a minute and try again.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json(429, { error: 'two_factor_locked', message: 'Locked' })),
    );
    await expect(api.loginStart('a@b.co')).rejects.toMatchObject({
      code: 'two_factor_locked',
      message: 'Locked',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({
  api: {
    loginStart: vi.fn(),
    loginFinish: vi.fn(),
    loginTwoFactor: vi.fn(),
    logout: vi.fn(),
    signupComplete: vi.fn(),
  },
}));
vi.mock('./device.js', () => ({
  thisDevice: () => Promise.resolve({ name: 'Mac', platform: 'macos', appVersion: '0.1.0' }),
}));
vi.mock('./core.js', () => ({
  core: {
    loginProve: vi.fn(),
    loginVerifyServer: vi.fn(),
    loginFinish: vi.fn(),
    createAccount: vi.fn(),
    lock: vi.fn(),
  },
}));

const { api } = await import('./api.js');
const { core } = await import('./core.js');
const { createAccount, needsTwoFactor, passwordProblem, signIn } = await import('./auth.js');

const kdf = { alg: 'argon2id', memoryKib: 262144, iterations: 3, parallelism: 4, salt: 's' };
const keyset = { v: 1, alg: 'xchacha20poly1305', kid: 'keyset', nonce: 'n', ct: 'c' };

describe('passwordProblem', () => {
  it('enforces length, match and not-the-email', () => {
    expect(passwordProblem('short', 'short', 'a@b.co')).toMatch(/at least 10/);
    expect(passwordProblem('alice@example.com', 'alice@example.com', 'Alice@Example.com')).toMatch(
      /email/,
    );
    expect(passwordProblem('long enough pw', 'long enough pv', 'a@b.co')).toMatch(/match/);
    expect(passwordProblem('long enough pw', 'long enough pw', 'a@b.co')).toBeNull();
  });
});

describe('signIn', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.loginStart).mockResolvedValue({ loginId: 'id', kdf, srpB: 'B' } as never);
    vi.mocked(core.loginProve).mockResolvedValue({ srpA: 'A', srpM1: 'M1' });
    vi.mocked(api.loginFinish).mockResolvedValue({
      srpM2: 'M2',
      sessionToken: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
      accountId: 'acct',
      encryptedKeyset: keyset,
    } as never);
    vi.mocked(api.logout).mockResolvedValue(undefined);
  });

  it('runs both SRP steps and returns the session', async () => {
    vi.mocked(core.loginFinish).mockResolvedValue({ email: 'a@b.co' });
    const session = await signIn('a@b.co', 'pw', 'Z1-...');
    expect(core.loginProve).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'pw',
      secretKey: 'Z1-...',
      kdf,
      srpB: 'B',
    });
    expect(api.loginFinish).toHaveBeenCalledWith({
      loginId: 'id',
      srpA: 'A',
      srpM1: 'M1',
      device: { name: 'Mac', platform: 'macos', appVersion: '0.1.0' },
    });
    expect(core.loginFinish).toHaveBeenCalledWith('M2', keyset);
    expect(session).toEqual({
      email: 'a@b.co',
      token: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('drops the session if the server fails to prove itself', async () => {
    vi.mocked(core.loginFinish).mockRejectedValue(
      'Incorrect email, master password or Secret Key.',
    );
    await expect(signIn('a@b.co', 'pw', 'sk')).rejects.toMatch(/Incorrect/);
    expect(api.logout).toHaveBeenCalledWith('tok');
  });
});

describe('signIn with 2FA', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.loginStart).mockResolvedValue({ loginId: 'id', kdf, srpB: 'B' } as never);
    vi.mocked(core.loginProve).mockResolvedValue({ srpA: 'A', srpM1: 'M1' });
    vi.mocked(api.loginFinish).mockResolvedValue({
      srpM2: 'M2',
      twoFactorRequired: true,
      twoFactorToken: 'tfa',
      expiresAt: '2030-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(api.logout).mockResolvedValue(undefined);
  });

  it('checks the server before asking for a code, then unlocks with it', async () => {
    vi.mocked(core.loginVerifyServer).mockResolvedValue(undefined);
    vi.mocked(api.loginTwoFactor).mockResolvedValue({
      sessionToken: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
      accountId: 'acct',
      encryptedKeyset: keyset,
    } as never);
    vi.mocked(core.loginFinish).mockResolvedValue({ email: 'a@b.co' });

    const result = await signIn('a@b.co', 'pw', 'sk');
    expect(core.loginVerifyServer).toHaveBeenCalledWith('M2');
    expect(api.loginTwoFactor).not.toHaveBeenCalled();
    if (!needsTwoFactor(result)) throw new Error('expected a 2FA challenge');

    await expect(result.complete({ code: '123456' })).resolves.toEqual({
      email: 'a@b.co',
      token: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(api.loginTwoFactor).toHaveBeenCalledWith({
      twoFactorToken: 'tfa',
      proof: { code: '123456' },
    });
    expect(core.loginFinish).toHaveBeenCalledWith('M2', keyset);
  });

  it('never sends a code to a server that fails its proof', async () => {
    vi.mocked(core.loginVerifyServer).mockRejectedValue('Incorrect');
    await expect(signIn('a@b.co', 'pw', 'sk')).rejects.toBe('Incorrect');
    expect(api.loginTwoFactor).not.toHaveBeenCalled();
  });
});

describe('createAccount', () => {
  it('uploads only public material and returns the Secret Key', async () => {
    vi.mocked(core.createAccount).mockResolvedValue({
      secretKey: 'Z1-SECRET',
      secretKeyId: 'ABC123',
      kdf,
      srpVerifier: 'v',
      encryptedKeyset: keyset,
    } as never);
    vi.mocked(api.signupComplete).mockResolvedValue({ accountId: 'acct' });
    await expect(createAccount('a@b.co', 'pw', 'token')).resolves.toBe('Z1-SECRET');
    const body = vi.mocked(api.signupComplete).mock.calls[0]![0];
    expect(JSON.stringify(body)).not.toContain('Z1-SECRET');
    expect(JSON.stringify(body)).not.toContain('"pw"');
  });
});

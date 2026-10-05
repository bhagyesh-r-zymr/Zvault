import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiRequestError,
    api: {
      loginStart: vi.fn(),
      logout: vi.fn(),
      session: vi.fn(),
      changePassword: vi.fn(),
      setUpRecovery: vi.fn(),
      recoverVerify: vi.fn(),
      recoverComplete: vi.fn(),
    },
  };
});
vi.mock('./device.js', () => ({
  thisDevice: () => Promise.resolve({ name: 'Mac', platform: 'macos', appVersion: '0.1.0' }),
}));
vi.mock('./core.js', () => ({
  core: {
    lock: vi.fn(),
    passwordChangeProve: vi.fn(),
    passwordChangeFinish: vi.fn(),
    recoverySetupProve: vi.fn(),
    recoverySetupFinish: vi.fn(),
    recoverBegin: vi.fn(),
    recoverReset: vi.fn(),
    recoverFinish: vi.fn(),
  },
}));
vi.mock('./lock.js', () => ({ lock: { restore: vi.fn(), saveForRestart: vi.fn() } }));

const { api, ApiRequestError } = await import('./api.js');
const { core } = await import('./core.js');
const { lock } = await import('./lock.js');
const {
  changeMasterPassword,
  errorMessage,
  finishRecovery,
  prepareRecovery,
  resumeSession,
  setUpRecovery,
  signOut,
  verifyRecovery,
} = await import('./auth.js');

const kdf = { alg: 'argon2id', memoryKib: 1, iterations: 1, parallelism: 1, salt: 's' };
const session = { email: 'a@b.co', token: 'tok', expiresAt: '2030-01-01T00:00:00.000Z' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.loginStart).mockResolvedValue({ loginId: 'L', kdf, srpB: 'B' } as never);
  vi.mocked(api.logout).mockResolvedValue(undefined);
});

describe('resumeSession', () => {
  it('returns null when nothing was saved or restoring fails', async () => {
    vi.mocked(lock.restore).mockResolvedValue(null);
    await expect(resumeSession()).resolves.toBeNull();
    vi.mocked(lock.restore).mockRejectedValue(new Error('no'));
    await expect(resumeSession()).resolves.toBeNull();
  });

  it('reopens a saved session the server still accepts', async () => {
    vi.mocked(lock.restore).mockResolvedValue(session);
    vi.mocked(api.session).mockResolvedValue({} as never);
    await expect(resumeSession()).resolves.toEqual(session);
  });

  it('opens offline, but drops a session the server ended', async () => {
    vi.mocked(lock.restore).mockResolvedValue(session);
    vi.mocked(api.session).mockRejectedValueOnce(new ApiRequestError(0, 'offline'));
    await expect(resumeSession()).resolves.toEqual(session);

    vi.mocked(api.session).mockRejectedValueOnce(new ApiRequestError(401, 'expired'));
    await expect(resumeSession()).resolves.toBeNull();
    expect(core.lock).toHaveBeenCalled();
    expect(api.logout).toHaveBeenCalledWith('tok');
  });
});

describe('signOut', () => {
  it('locks the core and ends the server session, even if the server is unreachable', async () => {
    vi.mocked(api.logout).mockRejectedValue(new Error('offline'));
    await expect(signOut(session)).resolves.toBeUndefined();
    expect(core.lock).toHaveBeenCalled();
  });
});

describe('changeMasterPassword', () => {
  it('proves, uploads, confirms the server and refreshes the saved session', async () => {
    vi.mocked(core.passwordChangeProve).mockResolvedValue({ srpA: 'A', srpM1: 'M1' } as never);
    vi.mocked(api.changePassword).mockResolvedValue({ srpM2: 'M2' } as never);
    vi.mocked(lock.saveForRestart).mockRejectedValue(new Error('ignored'));
    await changeMasterPassword(session, 'old', 'new');
    expect(core.passwordChangeProve).toHaveBeenCalledWith({
      currentPassword: 'old',
      newPassword: 'new',
      kdf,
      srpB: 'B',
    });
    expect(api.changePassword).toHaveBeenCalledWith('tok', {
      loginId: 'L',
      srpA: 'A',
      srpM1: 'M1',
    });
    expect(core.passwordChangeFinish).toHaveBeenCalledWith('M2');
    expect(lock.saveForRestart).toHaveBeenCalledWith('tok', session.expiresAt);
  });
});

describe('setUpRecovery', () => {
  it('returns the new recovery code', async () => {
    vi.mocked(core.recoverySetupProve).mockResolvedValue({ srpA: 'A' } as never);
    vi.mocked(api.setUpRecovery).mockResolvedValue({ srpM2: 'M2' } as never);
    vi.mocked(core.recoverySetupFinish).mockResolvedValue('R1-CODE');
    await expect(setUpRecovery(session, 'pw')).resolves.toBe('R1-CODE');
    expect(api.setUpRecovery).toHaveBeenCalledWith('tok', { loginId: 'L', srpA: 'A' });
    expect(core.recoverySetupFinish).toHaveBeenCalledWith('M2');
  });
});

describe('recovery', () => {
  const verifiedRes = {
    recoveryToken: 'rt',
    recoveryKeyset: { v: 1 },
    twoFactorRequired: false,
  };

  it('verifies the codes with the server', async () => {
    vi.mocked(core.recoverBegin).mockResolvedValue('auth');
    vi.mocked(api.recoverVerify).mockResolvedValue(verifiedRes as never);
    const v = await verifyRecovery('a@b.co', '123456', 'R1-X');
    expect(api.recoverVerify).toHaveBeenCalledWith({
      email: 'a@b.co',
      code: '123456',
      recoveryAuth: 'auth',
    });
    expect(v).toMatchObject({ email: 'a@b.co', recoveryToken: 'rt' });
  });

  it('prepares new keys from the released keyset', async () => {
    const v = { email: 'a@b.co', ...verifiedRes } as never;
    vi.mocked(core.recoverReset).mockResolvedValue({ secretKeyId: 'K' } as never);
    await expect(prepareRecovery(v, 'newpw')).resolves.toEqual({ secretKeyId: 'K' });
    expect(core.recoverReset).toHaveBeenCalledWith('newpw', verifiedRes.recoveryKeyset);
  });

  it('uploads the keys with and without a 2FA proof', async () => {
    const v = { email: 'a@b.co', ...verifiedRes } as never;
    const account = { secretKeyId: 'K' } as never;
    vi.mocked(api.recoverComplete).mockResolvedValue({
      sessionToken: 'new',
      expiresAt: 'exp',
    } as never);
    vi.mocked(core.recoverFinish).mockResolvedValue({ email: 'a@b.co', recoveryCode: 'R1-NEW' });
    const done = await finishRecovery(v, account, { code: '123456' });
    expect(done).toEqual({
      session: { email: 'a@b.co', token: 'new', expiresAt: 'exp' },
      recoveryCode: 'R1-NEW',
    });
    expect(vi.mocked(api.recoverComplete).mock.calls[0]![0]).toMatchObject({
      recoveryToken: 'rt',
      twoFactor: { code: '123456' },
      secretKeyId: 'K',
    });
    await finishRecovery(v, account, undefined);
    expect(vi.mocked(api.recoverComplete).mock.calls[1]![0]).not.toHaveProperty('twoFactor');
  });
});

describe('errorMessage', () => {
  it('reads errors and strings, and has a fallback', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
    expect(errorMessage(42)).toBe('Something went wrong.');
  });
});

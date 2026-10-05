import { describe, expect, it } from 'vitest';
import { core, maskedSecretKey } from './core.js';
import { mockCore } from './test/tauri.js';

describe('maskedSecretKey', () => {
  it('shows only the public id', () => {
    expect(maskedSecretKey('ABC123')).toBe('Z1-ABC123-•••••-•••••-•••••-•••••-•••••');
  });
});

describe('core bridge', () => {
  it('forwards each call to its Rust command with its arguments', async () => {
    const kdf = {
      alg: 'argon2id',
      memoryKib: 1,
      iterations: 1,
      parallelism: 1,
      salt: 's',
    } as never;
    const blob = { v: 1, alg: 'x', kid: 'k', nonce: 'n', ct: 'c' } as never;
    const table: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => core.info(), 'core_info', {}],
      [
        () => core.createAccount('a@b.co', 'pw'),
        'create_account',
        { email: 'a@b.co', password: 'pw' },
      ],
      [
        () => core.loginProve({ email: 'e', password: 'p', secretKey: null, kdf, srpB: 'B' }),
        'login_prove',
        { email: 'e', password: 'p', secretKey: null, kdf, srpB: 'B' },
      ],
      [() => core.loginVerifyServer('M2'), 'login_verify_server', { srpM2: 'M2' }],
      [() => core.loginFinish('M2', blob), 'login_finish', { srpM2: 'M2', encryptedKeyset: blob }],
      [() => core.lock(), 'lock', {}],
      [() => core.unlocked(), 'unlocked', {}],
      [() => core.emergencyKitPending(), 'emergency_kit_pending', {}],
      [() => core.saveEmergencyKit('a@b.co'), 'save_emergency_kit', { email: 'a@b.co' }],
      [() => core.discardEmergencyKit(), 'discard_emergency_kit', {}],
      [() => core.rememberedAccount(), 'remembered_account', {}],
      [() => core.importEmergencyKit(), 'import_emergency_kit', {}],
      [() => core.clearEmergencyKitImport(), 'clear_emergency_kit_import', {}],
      [() => core.forgetSecretKey(), 'forget_secret_key', {}],
      [
        () => core.passwordChangeProve({ currentPassword: 'a', newPassword: 'b', kdf, srpB: 'B' }),
        'password_change_prove',
        { currentPassword: 'a', newPassword: 'b', kdf, srpB: 'B' },
      ],
      [() => core.passwordChangeFinish('M2'), 'password_change_finish', { srpM2: 'M2' }],
      [
        () => core.recoverySetupProve({ password: 'p', kdf, srpB: 'B' }),
        'recovery_setup_prove',
        { password: 'p', kdf, srpB: 'B' },
      ],
      [() => core.recoverySetupFinish('M2'), 'recovery_setup_finish', { srpM2: 'M2' }],
      [() => core.saveRecoveryKit(), 'save_recovery_kit', {}],
      [() => core.discardRecoveryCode(), 'discard_recovery_code', {}],
      [
        () => core.recoverBegin('a@b.co', 'R1'),
        'recover_begin',
        { email: 'a@b.co', recoveryCode: 'R1' },
      ],
      [
        () => core.recoverReset('new', blob),
        'recover_reset',
        { newPassword: 'new', recoveryKeyset: blob },
      ],
      [() => core.recoverFinish(), 'recover_finish', {}],
      [() => core.recoverCancel(), 'recover_cancel', {}],
    ];
    const handlers = Object.fromEntries(table.map(([, cmd]) => [cmd, null]));
    const calls = mockCore(handlers);
    for (const [fn, cmd, args] of table) {
      calls.mockClear();
      await fn();
      expect(calls).toHaveBeenCalledWith(cmd, args);
    }
  });

  it('rejects when Rust fails', async () => {
    mockCore({
      lock: () => {
        throw new Error('boom');
      },
    });
    await expect(core.lock()).rejects.toThrow('boom');
  });
});

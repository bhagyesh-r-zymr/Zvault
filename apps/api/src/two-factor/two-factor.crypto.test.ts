import { randomBytes } from 'node:crypto';
import { RecoveryCode } from '@zvault/shared';
import { describe, expect, it } from 'vitest';
import { loadTwoFactorConfig } from './two-factor.config.js';
import { TwoFactorCrypto } from './two-factor.crypto.js';

describe('TwoFactorCrypto', () => {
  const crypto = new TwoFactorCrypto(randomBytes(32));

  it('seals secrets so only the same user id opens them', () => {
    const secret = randomBytes(20);
    const sealed = crypto.seal('alice', secret);
    expect(sealed).not.toContain(secret.toString('base64url'));
    expect(crypto.open('alice', sealed)).toEqual(secret);
    expect(() => crypto.open('bob', sealed)).toThrow();
    expect(() => new TwoFactorCrypto(randomBytes(32)).open('alice', sealed)).toThrow();
  });

  it('generates distinct recovery codes that parse as the shared format', () => {
    const { codes, hashes } = crypto.generateRecoveryCodes('alice');
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(RecoveryCode.parse(c)).toBe(c);
    expect(crypto.findRecoveryCode('alice', codes[3]!, hashes)).toBe(3);
    expect(crypto.findRecoveryCode('bob', codes[3]!, hashes)).toBe(-1);
  });
});

describe('loadTwoFactorConfig', () => {
  it('requires a key in production', () => {
    expect(() => loadTwoFactorConfig({ NODE_ENV: 'production' })).toThrow(/required/);
    const key = randomBytes(32).toString('base64url');
    const config = loadTwoFactorConfig({ NODE_ENV: 'production', TWO_FACTOR_ENCRYPTION_KEY: key });
    expect(config.masterKey.toString('base64url')).toBe(key);
  });

  it('rejects a key of the wrong size', () => {
    expect(() => loadTwoFactorConfig({ TWO_FACTOR_ENCRYPTION_KEY: 'short' })).toThrow();
  });
});

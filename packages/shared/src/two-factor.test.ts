import { describe, expect, it } from 'vitest';
import { RecoveryCode, TotpCode, TwoFactorProof, normalizeRecoveryCode } from './index.js';

describe('TotpCode', () => {
  it('accepts six digits and strips spaces', () => {
    expect(TotpCode.parse('123 456')).toBe('123456');
  });

  it('rejects anything else', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '']) {
      expect(TotpCode.safeParse(bad).success).toBe(false);
    }
  });
});

describe('RecoveryCode', () => {
  it('normalizes case, spacing and look-alike letters', () => {
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDE-FGHJK');
    expect(RecoveryCode.parse('o1il0-abcde')).toBe('01110-ABCDE');
  });

  it('rejects codes of the wrong shape', () => {
    expect(RecoveryCode.safeParse('ABCDE').success).toBe(false);
    expect(RecoveryCode.safeParse('ABCDE-FGHJU').success).toBe(false);
  });
});

describe('TwoFactorProof', () => {
  it('takes exactly one of code or recoveryCode', () => {
    expect(TwoFactorProof.safeParse({ code: '123456' }).success).toBe(true);
    expect(TwoFactorProof.safeParse({ recoveryCode: 'ABCDE-FGHJK' }).success).toBe(true);
    expect(TwoFactorProof.safeParse({ code: '123456', recoveryCode: 'ABCDE-FGHJK' }).success).toBe(
      false,
    );
    expect(TwoFactorProof.safeParse({}).success).toBe(false);
  });
});

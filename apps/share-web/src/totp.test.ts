import { describe, expect, it } from 'vitest';
import { codeAt, formatCode, parseTotp } from './totp.js';

// RFC 6238 appendix B: the ASCII key "12345678901234567890" (repeated for
// longer hashes), 8 digits.
const b32 = (ascii: string) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of ascii) bits += c.charCodeAt(0).toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};
const SHA1_KEY = b32('12345678901234567890');
const SHA256_KEY = b32('12345678901234567890123456789012');
const SHA512_KEY = b32('1234567890123456789012345678901234567890123456789012345678901234');

describe('totp', () => {
  it('matches the RFC 6238 vectors', () => {
    const cases: [string, string, number, string][] = [
      [SHA1_KEY, 'SHA1', 59, '94287082'],
      [SHA256_KEY, 'SHA256', 59, '46119246'],
      [SHA512_KEY, 'SHA512', 59, '90693936'],
      [SHA1_KEY, 'SHA1', 1111111109, '07081804'],
      [SHA1_KEY, 'SHA1', 20000000000, '65353130'],
      [SHA256_KEY, 'SHA256', 2000000000, '90698825'],
    ];
    for (const [key, alg, t, want] of cases) {
      const totp = parseTotp(`otpauth://totp/x?secret=${key}&algorithm=${alg}&digits=8`);
      expect(totp, alg).not.toBeNull();
      expect(codeAt(totp!, t).code).toBe(want);
    }
  });

  it('reads the label and defaults, and counts down', () => {
    const totp = parseTotp(
      'otpauth://totp/GitHub:octo%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    )!;
    expect(totp).toMatchObject({ issuer: 'GitHub', account: 'octo@example.com', digits: 6 });
    expect(totp.period).toBe(30);
    const c = codeAt(totp, 61);
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.remaining).toBe(29);
  });

  it('rejects what is not a TOTP setup', () => {
    for (const bad of [
      'JBSWY3DPEHPK3PXP',
      'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/x?secret=not*base32',
      'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5',
      'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
    ])
      expect(parseTotp(bad), bad).toBeNull();
  });

  it('groups digits', () => {
    expect(formatCode('123456')).toBe('123 456');
  });
});

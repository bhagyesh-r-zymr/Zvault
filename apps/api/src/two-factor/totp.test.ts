import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, timeStep, verifyTotp } from './totp.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" for SHA1.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP', () => {
  it('matches the RFC 6238 SHA1 test vectors (last 6 digits)', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SECRET, timeStep(seconds * 1000))).toBe(code);
    }
  });

  it('encodes base32 per RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('MZXW6YTBOI')).toEqual(Buffer.from('foobar'));
  });

  it('accepts one step of drift and nothing further', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '000000x', now, null)).toBeNull();
  });

  it('rejects a code whose step was already used', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it('builds a Key URI authenticator apps accept', () => {
    const uri = new URL(otpauthUri(RFC_SECRET, 'Zvault', 'ada@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Zvault:ada@example.com');
    expect(uri.searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri.searchParams.get('issuer')).toBe('Zvault');
    expect(uri.searchParams.get('digits')).toBe('6');
  });
});

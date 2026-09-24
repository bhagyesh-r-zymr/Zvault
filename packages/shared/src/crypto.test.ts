import { describe, expect, it } from 'vitest';
import { EncryptedBlob, KDF_DEFAULTS, KdfParams, SECRET_KEY_PATTERN } from './index.js';

const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64url');

describe('KdfParams', () => {
  it('accepts the client defaults', () => {
    expect(KdfParams.safeParse({ ...KDF_DEFAULTS, salt: b64(16) }).success).toBe(true);
  });

  it('rejects parameters weaker than the server floor', () => {
    const weak = { ...KDF_DEFAULTS, memoryKib: 1024, salt: b64(16) };
    expect(KdfParams.safeParse(weak).success).toBe(false);
  });

  it('rejects a salt of the wrong length', () => {
    expect(KdfParams.safeParse({ ...KDF_DEFAULTS, salt: b64(8) }).success).toBe(false);
  });
});

describe('EncryptedBlob', () => {
  const blob = { v: 1, alg: 'xchacha20poly1305', kid: 'vault-1', nonce: b64(24), ct: b64(48) };

  it('accepts a well-formed blob', () => {
    expect(EncryptedBlob.safeParse(blob).success).toBe(true);
  });

  it('rejects padded base64', () => {
    expect(EncryptedBlob.safeParse({ ...blob, ct: 'AAAA==' }).success).toBe(false);
  });

  it('rejects a short nonce', () => {
    expect(EncryptedBlob.safeParse({ ...blob, nonce: b64(12) }).success).toBe(false);
  });
});

describe('SECRET_KEY_PATTERN', () => {
  it('matches the Emergency Kit format and excludes ambiguous letters', () => {
    expect(SECRET_KEY_PATTERN.test('Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345')).toBe(true);
    expect(SECRET_KEY_PATTERN.test('Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-1234I')).toBe(false);
  });
});

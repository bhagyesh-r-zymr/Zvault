import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { RECOVERY_CODE_COUNT } from '@zvault/shared';

const SEALED_VERSION = 'v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function deriveKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `zvault/2fa/${purpose}`, 32));
}

/**
 * Server-side protection for 2FA material: TOTP secrets are sealed with
 * AES-256-GCM bound to the user id, and recovery codes are stored only as
 * keyed hashes, so a database dump alone yields neither.
 */
export class TwoFactorCrypto {
  private readonly sealKey: Buffer;
  private readonly pepper: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('2FA master key must be 32 bytes');
    this.sealKey = deriveKey(masterKey, 'totp-secret/v1');
    this.pepper = deriveKey(masterKey, 'recovery-code/v1');
  }

  seal(userId: string, secret: Uint8Array): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
    cipher.setAAD(aad(userId));
    const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
    return [SEALED_VERSION, iv, ct, cipher.getAuthTag()]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  open(userId: string, sealed: string): Buffer {
    const [version, iv, ct, tag] = sealed.split('.');
    if (version !== SEALED_VERSION || !iv || !ct || !tag)
      throw new Error('malformed sealed secret');
    const decipher = createDecipheriv('aes-256-gcm', this.sealKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
  }

  /** Fresh recovery codes (50 bits each) plus the hashes to store. */
  generateRecoveryCodes(userId: string): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      let raw = '';
      for (let i = 0; i < 10; i++) raw += CROCKFORD[randomInt(32)];
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { codes, hashes: codes.map((c) => this.hashRecoveryCode(userId, c)) };
  }

  /** `code` must already be normalized (see `RecoveryCode` in @zvault/shared). */
  hashRecoveryCode(userId: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${userId}\n${code}`).digest('base64url');
  }

  /** Index of the matching hash, comparing against every entry in constant time. */
  findRecoveryCode(userId: string, code: string, hashes: readonly string[]): number {
    const given = Buffer.from(this.hashRecoveryCode(userId, code));
    let found = -1;
    hashes.forEach((h, i) => {
      const stored = Buffer.from(h);
      if (stored.length === given.length && timingSafeEqual(stored, given) && found < 0) found = i;
    });
    return found;
  }
}

function aad(userId: string): Buffer {
  return Buffer.from(`zvault/2fa/totp-secret/v1\n${userId}`);
}

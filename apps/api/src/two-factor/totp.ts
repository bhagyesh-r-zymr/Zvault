import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_PARAMS } from '@zvault/shared';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s), implemented on node:crypto so the
 * second factor has no third-party dependency.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160-bit secrets, the size RFC 4226 recommends for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

/** Codes from one step either side are accepted to absorb clock drift. */
export const TOTP_DRIFT_STEPS = 1;

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Inverse of `base32Encode`; throws on characters outside the alphabet. */
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(c);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PARAMS.periodSeconds);
}

/** HOTP value for a counter (RFC 4226 section 5.3). */
export function hotp(secret: Uint8Array, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** TOTP_PARAMS.digits).toString().padStart(TOTP_PARAMS.digits, '0');
}

/**
 * Returns the time step `code` is valid for, or null. Every candidate step is
 * checked so timing does not reveal which one matched. Steps at or before
 * `lastUsedStep` are rejected so an observed code cannot be replayed.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  const current = timeStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      if (lastUsedStep === null || step > lastUsedStep) matched ??= step;
    }
  }
  return matched;
}

/** Key URI Format understood by Google Authenticator, 1Password, Authy, etc. */
export function otpauthUri(secret: Uint8Array, issuer: string, accountName: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: TOTP_PARAMS.algorithm,
    digits: String(TOTP_PARAMS.digits),
    period: String(TOTP_PARAMS.periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

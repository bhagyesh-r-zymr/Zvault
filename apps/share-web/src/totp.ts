import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

/**
 * RFC 6238 codes for a 2FA setup the sender chose to share. Parses the same
 * `otpauth://totp/` URIs that `zvault-otp` writes; the tests pin both to the
 * RFC's vectors.
 */

const HASHES = { SHA1: sha1, SHA256: sha256, SHA512: sha512 } as const;

export interface Totp {
  secret: Uint8Array;
  algorithm: keyof typeof HASHES;
  digits: number;
  period: number;
  issuer: string;
  account: string;
}

export interface Code {
  code: string;
  period: number;
  /** Whole seconds until the next code (1..=period). */
  remaining: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    const v = BASE32.indexOf(c);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out.length ? Uint8Array.from(out) : null;
}

/** Parses an `otpauth://totp/` URI, or returns null if it is not one. */
export function parseTotp(uri: string): Totp | null {
  const m = /^otpauth:\/\/totp\/([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  try {
    const label = decodeURIComponent(m[1] ?? '');
    const colon = label.indexOf(':');
    const params = new URLSearchParams(m[2] ?? '');
    const secret = base32Decode(params.get('secret') ?? '');
    const algorithm = (params.get('algorithm') ?? 'SHA1').toUpperCase();
    const digits = Number(params.get('digits') ?? 6);
    const period = Number(params.get('period') ?? 30);
    if (
      !secret ||
      !(algorithm in HASHES) ||
      !Number.isInteger(digits) ||
      digits < 6 ||
      digits > 8 ||
      !Number.isInteger(period) ||
      period < 1 ||
      period > 300
    )
      return null;
    return {
      secret,
      algorithm: algorithm as keyof typeof HASHES,
      digits,
      period,
      issuer: (params.get('issuer') ?? (colon >= 0 ? label.slice(0, colon) : '')).trim(),
      account: (colon >= 0 ? label.slice(colon + 1) : label).trim(),
    };
  } catch {
    return null;
  }
}

/** The code at `unixSecs`. */
export function codeAt(totp: Totp, unixSecs: number): Code {
  const counter = Math.floor(unixSecs / totp.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const digest = hmac(HASHES[totp.algorithm], totp.secret, msg);
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return {
    code: String(value % 10 ** totp.digits).padStart(totp.digits, '0'),
    period: totp.period,
    remaining: totp.period - (unixSecs % totp.period),
  };
}

/** Groups digits for reading aloud or typing: 123 456, 1234 5678. */
export function formatCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

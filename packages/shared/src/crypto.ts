import { z } from 'zod';
import { Base64Url, base64UrlOfLength } from './encoding.js';

/**
 * Crypto contracts. The server stores and relays these values but can never
 * decrypt them: every key they reference is derived or unwrapped on the client.
 */

export const CRYPTO_VERSION = 1 as const;

/** Floor the server enforces on sign-up; clients may choose stronger. */
export const KDF_MINIMUMS = { memoryKib: 64 * 1024, iterations: 3 } as const;
/** Ceiling the client and server both enforce, so hostile params can't exhaust memory. */
export const KDF_MAXIMUMS = { memoryKib: 4 * 1024 * 1024, iterations: 64 } as const;

/** Argon2id parameters used to stretch the master password on the client. */
export const KdfParams = z.object({
  alg: z.literal('argon2id'),
  /** Memory cost in KiB. */
  memoryKib: z.number().int().min(KDF_MINIMUMS.memoryKib).max(KDF_MAXIMUMS.memoryKib),
  iterations: z.number().int().min(KDF_MINIMUMS.iterations).max(KDF_MAXIMUMS.iterations),
  parallelism: z.number().int().min(1).max(16),
  salt: base64UrlOfLength(16),
});
export type KdfParams = z.infer<typeof KdfParams>;

/** Defaults new clients use (OWASP-aligned Argon2id, tuned for desktop). */
export const KDF_DEFAULTS = {
  alg: 'argon2id',
  memoryKib: 256 * 1024,
  iterations: 3,
  parallelism: 4,
} as const;

/**
 * An AEAD ciphertext as it travels to and from the server.
 * `nonce` is 24 bytes (XChaCha20-Poly1305); `ct` includes the 16-byte tag.
 */
export const EncryptedBlob = z.object({
  v: z.literal(CRYPTO_VERSION),
  alg: z.literal('xchacha20poly1305'),
  /** Id of the key that sealed this blob (e.g. a vault key id). */
  kid: z.string().min(1).max(64),
  nonce: base64UrlOfLength(24),
  ct: Base64Url,
});
export type EncryptedBlob = z.infer<typeof EncryptedBlob>;

/**
 * Secret Key shown once in the Emergency Kit. Only its public, non-secret
 * account-id prefix is ever sent to the server; the rest never leaves the device.
 * Format: `Z1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (Crockford base32).
 */
export const SECRET_KEY_PATTERN = /^Z1-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{5}){5}$/;

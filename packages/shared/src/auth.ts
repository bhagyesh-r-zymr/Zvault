import { z } from 'zod';
import { DeviceInfo } from './devices.js';
import { EncryptedBlob, KdfParams } from './crypto.js';
import { Base64Url, base64UrlOfLength } from './encoding.js';

/**
 * Sign-up, email verification and SRP-6a login contracts.
 *
 * The master password and Secret Key never appear here. The client derives an
 * SRP verifier and a sealed keyset from them and only those are uploaded.
 */

/** Bytes in an SRP group element (RFC 5054 3072-bit group). */
export const SRP_GROUP_BYTES = 384;
/** Bytes in an SRP proof (SHA-256). */
export const SRP_PROOF_BYTES = 32;
/** Digits in an email verification code. */
export const VERIFICATION_CODE_LENGTH = 6;

/** Canonical account id. Mirrors `normalize_account_id` in `zvault-crypto`. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const Email = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.email({ message: 'must be a valid email address' }));

/** The public six-character id prefix of a Secret Key. */
export const SecretKeyId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

const SrpElement = base64UrlOfLength(SRP_GROUP_BYTES);
const SrpProof = base64UrlOfLength(SRP_PROOF_BYTES);

export const SignupStartRequest = z.object({ email: Email });
export type SignupStartRequest = z.input<typeof SignupStartRequest>;

export const SignupVerifyRequest = z.object({
  email: Email,
  code: z.string().regex(new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`), 'must be 6 digits'),
});
export type SignupVerifyRequest = z.input<typeof SignupVerifyRequest>;

export const SignupVerifyResponse = z.object({
  /** Single-use proof that the email was verified; spent by `signup/complete`. */
  signupToken: Base64Url,
  expiresAt: z.iso.datetime(),
});
export type SignupVerifyResponse = z.infer<typeof SignupVerifyResponse>;

export const SignupCompleteRequest = z.object({
  signupToken: Base64Url,
  secretKeyId: SecretKeyId,
  kdf: KdfParams,
  srpVerifier: SrpElement,
  /** The account keyset, sealed with the unlock key. */
  encryptedKeyset: EncryptedBlob,
});
export type SignupCompleteRequest = z.input<typeof SignupCompleteRequest>;

export const SignupCompleteResponse = z.object({ accountId: z.uuid() });
export type SignupCompleteResponse = z.infer<typeof SignupCompleteResponse>;

export const LoginStartRequest = z.object({ email: Email });
export type LoginStartRequest = z.input<typeof LoginStartRequest>;

/**
 * Returned for every email, registered or not, so it cannot be used to find
 * out who has an account.
 */
export const LoginStartResponse = z.object({
  loginId: z.uuid(),
  kdf: KdfParams,
  srpB: SrpElement,
});
export type LoginStartResponse = z.infer<typeof LoginStartResponse>;

export const LoginFinishRequest = z.object({
  loginId: z.uuid(),
  srpA: SrpElement,
  srpM1: SrpProof,
  device: DeviceInfo,
});
export type LoginFinishRequest = z.input<typeof LoginFinishRequest>;

export const LoginFinishResponse = z.object({
  /** Server proof; the client must check it before trusting anything else here. */
  srpM2: SrpProof,
  sessionToken: Base64Url,
  expiresAt: z.iso.datetime(),
  accountId: z.uuid(),
  encryptedKeyset: EncryptedBlob,
});
export type LoginFinishResponse = z.infer<typeof LoginFinishResponse>;

export const SessionResponse = z.object({
  accountId: z.uuid(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Error body for every non-2xx response. */
export const ApiError = z.object({
  statusCode: z.number().int(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

import { z } from 'zod';
import { Email, SecretKeyId, VERIFICATION_CODE_LENGTH } from './auth.js';
import { EncryptedBlob, KdfParams } from './crypto.js';
import { DeviceInfo } from './devices.js';
import { Base64Url, base64UrlOfLength } from './encoding.js';
import { TwoFactorProof } from './two-factor.js';

/**
 * Master password change and account recovery.
 *
 * Changing the master password keeps the Secret Key and the keyset: the app
 * re-derives the unlock key and SRP verifier from the new password and
 * re-seals the same keyset, so nothing in the vault is re-encrypted.
 *
 * Account recovery uses a recovery code the app generates and shows once. It
 * seals a second copy of the keyset; the server stores that copy and
 * `SHA-256(auth token)`, both derived from the code on the device, and never
 * sees the code itself. Recovering needs the code, a code emailed to the
 * account and, when 2FA is on, a 2FA code. It sets a new master password and
 * a new Secret Key, and replaces the recovery code.
 */

/** Bytes in the recovery auth token and its SHA-256 verifier. */
export const RECOVERY_TOKEN_BYTES = 32;

const SrpElement = base64UrlOfLength(384);
const SrpProof = base64UrlOfLength(32);
const RecoveryToken = base64UrlOfLength(RECOVERY_TOKEN_BYTES);

/**
 * Proof of the current master password for a signed-in change: the app starts
 * a login (`auth/login/start`) for its own email and answers it. The server
 * checks the proof like a login but opens no session.
 */
export const Reauthentication = z.object({
  loginId: z.uuid(),
  srpA: SrpElement,
  srpM1: SrpProof,
});
export type Reauthentication = z.input<typeof Reauthentication>;

/** Server proof for a re-authenticated change; the app checks it before trusting the change. */
export const ReauthenticatedResponse = z.object({ srpM2: SrpProof });
export type ReauthenticatedResponse = z.infer<typeof ReauthenticatedResponse>;

/** The recovery copy of the keyset and the verifier for the code that seals it. */
export const AccountRecoveryMaterial = z.object({
  recoveryKeyset: EncryptedBlob,
  recoveryVerifier: RecoveryToken,
});
export type AccountRecoveryMaterial = z.input<typeof AccountRecoveryMaterial>;

export const PasswordChangeRequest = Reauthentication.extend({
  kdf: KdfParams,
  srpVerifier: SrpElement,
  /** The same keyset, sealed with the unlock key from the new password. */
  encryptedKeyset: EncryptedBlob,
});
export type PasswordChangeRequest = z.input<typeof PasswordChangeRequest>;

export const AccountRecoveryStatus = z.object({
  enabled: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
});
export type AccountRecoveryStatus = z.infer<typeof AccountRecoveryStatus>;

/** Sets up or replaces the account's recovery code. */
export const AccountRecoverySetupRequest = Reauthentication.extend(AccountRecoveryMaterial.shape);
export type AccountRecoverySetupRequest = z.input<typeof AccountRecoverySetupRequest>;

export const RecoverStartRequest = z.object({ email: Email });
export type RecoverStartRequest = z.input<typeof RecoverStartRequest>;

export const RecoverVerifyRequest = z.object({
  email: Email,
  code: z.string().regex(new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`), 'must be 6 digits'),
  /** Derived from the recovery code on the device. */
  recoveryAuth: RecoveryToken,
});
export type RecoverVerifyRequest = z.input<typeof RecoverVerifyRequest>;

export const RecoverVerifyResponse = z.object({
  /** Single-use handle for `recover/complete`. */
  recoveryToken: Base64Url,
  expiresAt: z.iso.datetime(),
  /** Opened on the device with the recovery code. */
  recoveryKeyset: EncryptedBlob,
  /** Whether `recover/complete` needs a 2FA code. */
  twoFactorRequired: z.boolean(),
});
export type RecoverVerifyResponse = z.infer<typeof RecoverVerifyResponse>;

export const RecoverCompleteRequest = AccountRecoveryMaterial.extend({
  recoveryToken: base64UrlOfLength(32),
  twoFactor: TwoFactorProof.optional(),
  secretKeyId: SecretKeyId,
  kdf: KdfParams,
  srpVerifier: SrpElement,
  encryptedKeyset: EncryptedBlob,
  device: DeviceInfo,
});
export type RecoverCompleteRequest = z.input<typeof RecoverCompleteRequest>;

/** A new session: every other session of the account was signed out. */
export const RecoverCompleteResponse = z.object({
  sessionToken: Base64Url,
  expiresAt: z.iso.datetime(),
  accountId: z.uuid(),
});
export type RecoverCompleteResponse = z.infer<typeof RecoverCompleteResponse>;

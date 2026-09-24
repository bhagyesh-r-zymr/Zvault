import { z } from 'zod';

/**
 * Two-factor (TOTP) contracts. TOTP is a server-enforced second factor, so the
 * server must know the TOTP secret; it keeps it encrypted at rest and never
 * returns it after enrollment. It is unrelated to vault encryption keys.
 */

/** RFC 6238 parameters every mainstream authenticator app supports. */
export const TOTP_PARAMS = {
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
} as const;

export const RECOVERY_CODE_COUNT = 10;

/** A 6-digit TOTP code. Spaces are stripped before validation. */
export const TotpCode = z
  .string()
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'must be a 6-digit code'));

/** Recovery codes are shown as `XXXXX-XXXXX` (Crockford base32, case-insensitive). */
export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

export const RecoveryCode = z
  .string()
  .transform(normalizeRecoveryCode)
  .pipe(z.string().regex(RECOVERY_CODE_PATTERN, 'must look like XXXXX-XXXXX'));

/** Uppercases, drops whitespace and hyphens, maps look-alikes, then re-inserts the hyphen. */
export function normalizeRecoveryCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

export const TwoFactorStatusResponse = z.object({
  totpEnabled: z.boolean(),
  /** Unused recovery codes left; 0 when 2FA is off. */
  recoveryCodesRemaining: z.number().int().min(0),
  enabledAt: z.iso.datetime().nullable(),
});
export type TwoFactorStatusResponse = z.infer<typeof TwoFactorStatusResponse>;

/** Returned once when setup starts. The client renders the QR code locally. */
export const TotpSetupResponse = z.object({
  /** `otpauth://totp/...` URI to encode as a QR code. */
  otpauthUri: z.string().startsWith('otpauth://totp/'),
  /** Base32 secret for manual entry when the QR code can't be scanned. */
  secret: z.string().regex(/^[A-Z2-7]+$/),
  expiresAt: z.iso.datetime(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

export const TotpConfirmRequest = z.object({ code: TotpCode });
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequest>;

/** Recovery codes in plaintext. Shown once; the server only keeps their hashes. */
export const RecoveryCodesResponse = z.object({
  recoveryCodes: z.array(z.string().regex(RECOVERY_CODE_PATTERN)).length(RECOVERY_CODE_COUNT),
});
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;

/** Proves possession of the second factor: a current TOTP code or one recovery code. */
export const TwoFactorProof = z.union([
  z.object({ code: TotpCode }).strict(),
  z.object({ recoveryCode: RecoveryCode }).strict(),
]);
export type TwoFactorProof = z.infer<typeof TwoFactorProof>;

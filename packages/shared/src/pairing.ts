import { z } from 'zod';
import { base64UrlOfLength } from './encoding.js';
import { DeviceInfo } from './devices.js';
import { SharingPublicKey } from './sharing.js';

/**
 * Signing a phone in by scanning a QR code on a signed-in device.
 *
 * The signed-in device creates a pairing and shows a QR code holding the
 * pairing id, its own public key and a pairing secret. The phone claims the
 * pairing with a token derived from that secret and sends its public key.
 * Both screens show a code over the secret and both keys; when the person
 * allows it, the signed-in device seals the account keys to the phone and the
 * server issues the phone its own session. The server relays public keys and
 * one sealed box, and never sees the secret or the account keys.
 */

export const PAIRING_LIMITS = {
  /** From creation to the phone collecting its grant. */
  ttlSeconds: 3 * 60,
} as const;

/** HKDF of the pairing secret. The server keeps only its SHA-256. */
export const PairingClaimToken = base64UrlOfLength(32);

export const PairingId = z.uuid();

export const CreatePairingRequest = z.object({ claimToken: PairingClaimToken });
export type CreatePairingRequest = z.infer<typeof CreatePairingRequest>;

export const CreatePairingResponse = z.object({
  id: PairingId,
  expiresAt: z.iso.datetime(),
});
export type CreatePairingResponse = z.infer<typeof CreatePairingResponse>;

/** Sent by the phone, which has no session yet. */
export const ClaimPairingRequest = z.object({
  claimToken: PairingClaimToken,
  publicKey: SharingPublicKey,
  device: DeviceInfo,
});
export type ClaimPairingRequest = z.infer<typeof ClaimPairingRequest>;

export const PairingStatus = z.enum(['waiting', 'claimed', 'approved', 'denied']);
export type PairingStatus = z.infer<typeof PairingStatus>;

/** What the signed-in device polls while the QR code is on screen. */
export const PairingView = z.object({
  id: PairingId,
  status: PairingStatus,
  expiresAt: z.iso.datetime(),
  /** Set once a phone has claimed the pairing. */
  device: DeviceInfo.nullable(),
  publicKey: SharingPublicKey.nullable(),
});
export type PairingView = z.infer<typeof PairingView>;

/** The account keys sealed to the phone's key (see `seal_grant` in zvault-crypto). */
export const PairingGrant = z.object({
  ephemeralPublicKey: SharingPublicKey,
  nonce: base64UrlOfLength(24),
  ct: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(4096),
});
export type PairingGrant = z.infer<typeof PairingGrant>;

export const ApprovePairingRequest = z.object({ grant: PairingGrant });
export type ApprovePairingRequest = z.infer<typeof ApprovePairingRequest>;

/** The phone polls with its claim token until the pairing is decided. */
export const PairingResultRequest = z.object({ claimToken: PairingClaimToken });
export type PairingResultRequest = z.infer<typeof PairingResultRequest>;

export const PairingResultResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting') }),
  z.object({ status: z.literal('denied') }),
  z.object({
    status: z.literal('approved'),
    /** Bearer token for the phone's new session. Returned once. */
    sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    grant: PairingGrant,
  }),
]);
export type PairingResultResponse = z.infer<typeof PairingResultResponse>;

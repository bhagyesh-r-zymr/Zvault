import { z } from 'zod';
import { EncryptedBlob } from './crypto.js';
import { base64UrlOfLength } from './encoding.js';

/**
 * Sharing contracts. Link keys live only in URL fragments and sharing secret
 * keys only on devices; the server sees ids, ciphertext, public keys and
 * SHA-256 verifiers of link access tokens.
 */

/** Share ids are 16 random bytes chosen by the sender's device. */
export const ShareId = base64UrlOfLength(16);
export type ShareId = z.infer<typeof ShareId>;

/** X25519 public key. */
export const SharingPublicKey = base64UrlOfLength(32);
export type SharingPublicKey = z.infer<typeof SharingPublicKey>;

export const SHARE_LIMITS = {
  minTtlSeconds: 5 * 60,
  defaultTtlSeconds: 7 * 24 * 60 * 60,
  maxTtlSeconds: 30 * 24 * 60 * 60,
  maxViews: 100,
  /** Plaintext items are small; this bounds storage abuse. */
  maxCiphertextBytes: 64 * 1024,
  maxActiveLinksPerUser: 200,
  /** People an email-restricted link can name. */
  maxAllowedEmails: 20,
  /** One-time codes for email-restricted links. */
  codeTtlMinutes: 10,
  codeLength: 6,
} as const;

/** Emails are compared trimmed and lowercased. */
export const ShareEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** The `kid` a share blob is sealed under. */
export const SHARE_LINK_KID = 'share-link' as const;
export const SHARE_BOX_KID = 'share-box' as const;

const shareBlob = (kid: string) =>
  EncryptedBlob.extend({ kid: z.literal(kid) }).refine(
    (b) => b.ct.length <= Math.ceil((SHARE_LIMITS.maxCiphertextBytes * 4) / 3),
    {
      message: `ciphertext must be at most ${SHARE_LIMITS.maxCiphertextBytes} bytes`,
      path: ['ct'],
    },
  );

const ttlSeconds = z.number().int().min(SHARE_LIMITS.minTtlSeconds).max(SHARE_LIMITS.maxTtlSeconds);

const IsoDate = z.iso.datetime();

/** What the decrypted payload of any share looks like. Never sent to the server. */
export const SharedItemPayload = z.object({
  v: z.literal(1),
  title: z.string().max(200),
  username: z.string().max(500).optional(),
  password: z.string().max(4096).optional(),
  url: z.string().max(2048).optional(),
  notes: z.string().max(10_000).optional(),
  /**
   * Set when a project secret is shared rather than a vault item. Its value
   * travels in `password`, so apps that predate this field still show it.
   */
  secret: z
    .object({
      key: z.string().max(256),
      project: z.string().max(200),
      environment: z.string().max(200),
    })
    .optional(),
});
export type SharedItemPayload = z.infer<typeof SharedItemPayload>;

/** The payload for one project secret's value in one environment. */
export function secretSharePayload(s: {
  name: string;
  key: string;
  value: string;
  note?: string | undefined;
  project: string;
  environment: string;
}): SharedItemPayload {
  return {
    v: 1,
    title: s.name || s.key,
    password: s.value,
    ...(s.note && { notes: s.note }),
    secret: { key: s.key, project: s.project, environment: s.environment },
  };
}

// ---------------------------------------------------------------- links

export const CreateShareLinkRequest = z.object({
  id: ShareId,
  blob: shareBlob(SHARE_LINK_KID),
  /** SHA-256 of the access token derived from the link key. */
  verifier: base64UrlOfLength(32),
  expiresInSeconds: ttlSeconds.default(SHARE_LIMITS.defaultTtlSeconds),
  maxViews: z.number().int().min(1).max(SHARE_LIMITS.maxViews).default(1),
  /**
   * When set, only these people can open the link: each must confirm their
   * email with a one-time code first. The link key still never reaches the
   * server.
   */
  allowedEmails: z
    .array(ShareEmail)
    .min(1)
    .max(SHARE_LIMITS.maxAllowedEmails)
    .transform((emails) => [...new Set(emails)])
    .optional(),
});
export type CreateShareLinkRequest = z.infer<typeof CreateShareLinkRequest>;
/** What a client sends: `expiresInSeconds` and `maxViews` have defaults. */
export type CreateShareLinkInput = z.input<typeof CreateShareLinkRequest>;

export const ShareLinkSummary = z.object({
  id: ShareId,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  maxViews: z.number().int(),
  viewCount: z.number().int(),
  /** How many people the link is limited to; 0 means anyone with the link. */
  allowedEmailCount: z.number().int().min(0).default(0),
  status: z.enum(['active', 'expired', 'used_up', 'revoked']),
});
export type ShareLinkSummary = z.infer<typeof ShareLinkSummary>;

export const CreateShareLinkResponse = ShareLinkSummary.extend({
  /**
   * Allowed emails that may not receive the code while Zvault email is in
   * sandbox mode (only verified addresses get mail). Empty otherwise.
   */
  unverifiedEmails: z.array(z.string()).default([]),
});
export type CreateShareLinkResponse = z.infer<typeof CreateShareLinkResponse>;

export const ShareLinkList = z.object({ links: z.array(ShareLinkSummary) });
export type ShareLinkList = z.infer<typeof ShareLinkList>;

const LinkAccessToken = base64UrlOfLength(32);

/** Asks whether a link needs an email check before it opens. Counts no view. */
export const CheckShareLinkRequest = z.object({ accessToken: LinkAccessToken });
export type CheckShareLinkRequest = z.infer<typeof CheckShareLinkRequest>;

export const CheckShareLinkResponse = z.object({ emailRequired: z.boolean() });
export type CheckShareLinkResponse = z.infer<typeof CheckShareLinkResponse>;

/**
 * Emails a one-time code to `email` if the link allows it. The answer is the
 * same whether or not it does, so the list of people can't be probed.
 */
export const RequestShareCodeRequest = z.object({
  accessToken: LinkAccessToken,
  email: ShareEmail,
});
export type RequestShareCodeRequest = z.infer<typeof RequestShareCodeRequest>;

export const ShareCode = z
  .string()
  .trim()
  .regex(new RegExp(`^[0-9]{${SHARE_LIMITS.codeLength}}$`));

export const OpenShareLinkRequest = z.object({
  accessToken: LinkAccessToken,
  /** Required, with `code`, for email-restricted links. */
  email: ShareEmail.optional(),
  code: ShareCode.optional(),
});
export type OpenShareLinkRequest = z.infer<typeof OpenShareLinkRequest>;

/**
 * Why a link that the caller holds the key for did not open: it needs an
 * email check, or the email and code given don't match a live code.
 */
export const ShareLinkDenial = z.object({
  reason: z.enum(['email_required', 'invalid_code']),
  message: z.string(),
});
export type ShareLinkDenial = z.infer<typeof ShareLinkDenial>;

export const OpenShareLinkResponse = z.object({
  blob: shareBlob(SHARE_LINK_KID),
  expiresAt: IsoDate,
  viewsRemaining: z.number().int().min(0),
});
export type OpenShareLinkResponse = z.infer<typeof OpenShareLinkResponse>;

// ---------------------------------------------------------------- user shares

export const PublishSharingKeyRequest = z.object({ publicKey: SharingPublicKey });
export type PublishSharingKeyRequest = z.infer<typeof PublishSharingKeyRequest>;

export const SharingKeyResponse = z.object({
  userId: z.string(),
  email: z.email(),
  publicKey: SharingPublicKey,
});
export type SharingKeyResponse = z.infer<typeof SharingKeyResponse>;

export const CreateUserShareRequest = z.object({
  id: ShareId,
  recipientEmail: z.email().max(254),
  /** The recipient key the sender encrypted to, as the sender saw it. */
  recipientPublicKey: SharingPublicKey,
  /** The sender's own published key; must match what the server has on file. */
  senderPublicKey: SharingPublicKey,
  ephemeralPublicKey: SharingPublicKey,
  blob: shareBlob(SHARE_BOX_KID),
  expiresInSeconds: ttlSeconds.optional(),
});
export type CreateUserShareRequest = z.infer<typeof CreateUserShareRequest>;
export type CreateUserShareInput = z.input<typeof CreateUserShareRequest>;

const UserRef = z.object({ userId: z.string(), email: z.email() });

export const IncomingUserShare = z.object({
  id: ShareId,
  sender: UserRef.extend({ publicKey: SharingPublicKey }),
  ephemeralPublicKey: SharingPublicKey,
  blob: shareBlob(SHARE_BOX_KID),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
});
export type IncomingUserShare = z.infer<typeof IncomingUserShare>;

export const OutgoingUserShare = z.object({
  id: ShareId,
  recipient: UserRef,
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
});
export type OutgoingUserShare = z.infer<typeof OutgoingUserShare>;

export const UserShareList = z.object({
  incoming: z.array(IncomingUserShare),
  outgoing: z.array(OutgoingUserShare),
});
export type UserShareList = z.infer<typeof UserShareList>;

import { z } from 'zod';
import { base64UrlOfLength } from './encoding.js';
import { EncryptedBlob } from './crypto.js';
import { SyncProjectResponse } from './projects.js';
import { RecordId, WrappedKey } from './vault.js';

/**
 * Access tokens for cloud agents and CI: read one environment of one project
 * without the Zvault app.
 *
 * ```text
 * token secret ──HKDF──► auth key ──SHA-256──► verifier (stored by the server)
 *              └─HKDF──► wrap key ──wraps──► project key, environment key(s)
 * ```
 *
 * The token is made on a device that holds the keys (`AgentToken` in
 * `crates/zvault-crypto/src/token.rs`). The server stores the verifier and the
 * wrapped keys; `zv` sends the auth key, gets the wraps and the project's
 * ciphertext back, and decrypts locally. Tokens are read-only, expire, can be
 * revoked, and stop working when their creator loses access to the
 * environment or its key is rotated.
 */

/** `kid` of a key wrapped with a token's wrap key. */
export const TOKEN_KID = 'agent-token';

export const MAX_TOKENS_PER_PROJECT = 50;
/** Longest a token may live. */
export const MAX_TOKEN_DAYS = 365;
/** Lifetimes the app offers, in days. */
export const TOKEN_LIFETIMES = [1, 7, 30, 90, 365] as const;

const TokenWrap = WrappedKey.refine((b) => b.kid === TOKEN_KID, {
  message: `kid must be ${TOKEN_KID}`,
});

export const TokenEnvironmentKey = z.object({
  environmentId: RecordId,
  /** The key version the wrap is bound to; 1 until the environment is rotated. */
  keyVersion: z.number().int().min(1),
  encryptedKey: TokenWrap,
});
export type TokenEnvironmentKey = z.infer<typeof TokenEnvironmentKey>;

export const CreateTokenRequest = z.object({
  /** Chosen on the device; the wraps are bound to it. */
  id: RecordId,
  /** What it is for, shown in the app: "GitHub Actions deploy". */
  name: z.string().trim().min(1).max(100),
  /** `SHA-256(auth key)`, base64url. */
  verifier: base64UrlOfLength(32),
  expiresAt: z.iso.datetime(),
  encryptedProjectKey: TokenWrap,
  /**
   * The environment the token reads first, then the environments it inherits
   * values from, nearest first. A secret with no value in one falls back to
   * the next.
   */
  environments: z.array(TokenEnvironmentKey).min(1).max(20),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

export const TokenView = z.object({
  id: RecordId,
  name: z.string(),
  /** The environment the token reads, then the ones it falls back to. */
  environmentIds: z.array(RecordId),
  createdBy: z.object({ id: RecordId, email: z.string() }),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** An environment key was rotated since; the token no longer works and must be re-issued. */
  stale: z.boolean(),
});
export type TokenView = z.infer<typeof TokenView>;

export const ListTokensResponse = z.object({ tokens: z.array(TokenView) });
export type ListTokensResponse = z.infer<typeof ListTokensResponse>;

/** `GET /v1/token`: what a token opens, for `zv`. */
export const TokenSessionResponse = z.object({
  token: z.object({
    id: RecordId,
    name: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  project: z.object({
    id: RecordId,
    encryptedMeta: EncryptedBlob,
    /** The project key wrapped for the token. */
    encryptedKey: TokenWrap,
  }),
  environments: z.array(TokenEnvironmentKey),
});
export type TokenSessionResponse = z.infer<typeof TokenSessionResponse>;

/**
 * `GET /v1/token/changes`: the project's entries as the token sees them.
 * Environment entries carry no key (the keys are in `TokenSessionResponse`)
 * and secrets carry only the values of the token's environments.
 */
export const TokenChangesResponse = SyncProjectResponse;
export type TokenChangesResponse = z.infer<typeof TokenChangesResponse>;

/** `Authorization: Bearer <token id>.<auth key, base64url>`. */
export const TOKEN_BEARER = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

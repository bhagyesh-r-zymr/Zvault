import type { DeviceInfo, EncryptedBlob } from '@zvault/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => Buffer.from(v),
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Argon2id parameters as stored; the salt is base64url. */
export interface StoredKdf {
  alg: 'argon2id';
  memoryKib: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

/**
 * One row per account. Nothing here can be used to decrypt a vault: the
 * verifier is `g^x`, and the keyset is sealed with a key only the client can
 * derive (it needs the master password and the Secret Key).
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Normalized (trimmed, lowercased). */
  email: text('email').notNull().unique(),
  secretKeyId: text('secret_key_id').notNull(),
  kdf: jsonb('kdf').$type<StoredKdf>().notNull(),
  srpVerifier: bytea('srp_verifier').notNull(),
  encryptedKeyset: jsonb('encrypted_keyset').$type<EncryptedBlob>().notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Sign-up email verification. A code is stored only as an HMAC; once it is
 * entered correctly the row carries a single-use sign-up token (also hashed).
 */
export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: bytea('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    verifiedAt: ts('verified_at'),
    /** Closed without success: superseded, or too many wrong codes. */
    closedAt: ts('closed_at'),
    tokenHash: bytea('token_hash').unique(),
    tokenExpiresAt: ts('token_expires_at'),
    tokenUsedAt: ts('token_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('email_verifications_email_idx').on(t.email, t.createdAt)],
);

/**
 * In-flight SRP logins (the server's ephemeral `b`), kept for two minutes and
 * deleted on first use. `accountId` is null for decoy logins to unknown emails.
 */
export const srpChallenges = pgTable(
  'srp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    secretB: bytea('secret_b').notNull(),
    publicB: bytea('public_b').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('srp_challenges_expires_idx').on(t.expiresAt)],
);

/** Login sessions. Only a SHA-256 of the bearer token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    /** What the client said about itself at sign-in, shown in the device list. */
    device: jsonb('device').$type<DeviceInfo>().notNull(),
    /** Absolute end of the session; idle expiry is checked against lastSeenAt. */
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastSeenAt: ts('last_seen_at')
      .notNull()
      .default(sql`now()`),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_account_idx').on(t.accountId)],
);

/**
 * Two-factor (TOTP) state, one row per account that has ever started setup.
 * Secrets are sealed with `TWO_FACTOR_ENCRYPTION_KEY`; recovery codes are
 * stored only as keyed hashes. `version` makes every write a compare-and-set.
 */
export const twoFactor = pgTable('two_factor', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  totpSecret: text('totp_secret'),
  enabledAt: ts('enabled_at'),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  pendingSecret: text('pending_secret'),
  pendingExpiresAt: ts('pending_expires_at'),
  recoveryCodeHashes: jsonb('recovery_code_hashes').$type<string[]>().notNull().default([]),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: ts('locked_until'),
  version: integer('version').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Logins that passed the password step and wait for a 2FA code. Holds the
 * device so the session can be issued once the code checks out. Only a hash
 * of the token is stored; rows are deleted on success or expiry.
 */
export const loginTwoFactorChallenges = pgTable(
  'login_two_factor_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    device: jsonb('device').$type<DeviceInfo>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('login_two_factor_challenges_expires_idx').on(t.expiresAt)],
);

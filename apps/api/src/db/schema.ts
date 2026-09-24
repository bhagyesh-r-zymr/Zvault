import type { DeviceInfo, EncryptedBlob } from '@zvault/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
 * Vaults of login items. `seq` is the vault's change counter: every item
 * write takes the next value, which becomes the item's sync cursor.
 */
export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    encryptedKey: jsonb('encrypted_key').$type<EncryptedBlob>().notNull(),
    encryptedMeta: jsonb('encrypted_meta').$type<EncryptedBlob>().notNull(),
    seq: integer('seq').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('vaults_owner_idx').on(t.ownerId)],
);

/** Vault items; a deleted item keeps its row (without blobs) as a tombstone. */
export const vaultItems = pgTable(
  'vault_items',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    revision: integer('revision').notNull(),
    seq: integer('seq').notNull(),
    deleted: boolean('deleted').notNull().default(false),
    encryptedKey: jsonb('encrypted_key').$type<EncryptedBlob>(),
    encryptedData: jsonb('encrypted_data').$type<EncryptedBlob>(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.id] }),
    index('vault_items_seq_idx').on(t.vaultId, t.seq),
  ],
);

/**
 * Projects of secrets. Everything readable about a project (its name, its
 * environments' and folders' names, secret names and tags) is sealed with the
 * project key, which the server never holds.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    encryptedMeta: jsonb('encrypted_meta').$type<EncryptedBlob>().notNull(),
    revision: integer('revision').notNull().default(1),
    /** Change counter shared by all of the project's entries. */
    seq: integer('seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('projects_owner_idx').on(t.ownerId)],
);

/**
 * Who holds which key. `resourceId` is the project id (the project key) or
 * one of its environment ids (that environment's key); `wrappedKey` is the
 * key wrapped for `accountId`. Holding a grant is what access means.
 */
export const keyGrants = pgTable(
  'key_grants',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    wrappedKey: jsonb('wrapped_key').$type<EncryptedBlob>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.resourceId, t.accountId] }),
    index('key_grants_account_idx').on(t.accountId),
  ],
);

/** Environments, folders and secrets of a project. Deleted entries stay as tombstones. */
export const projectEntries = pgTable(
  'project_entries',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    type: text('type').$type<'environment' | 'folder' | 'secret'>().notNull(),
    revision: integer('revision').notNull(),
    seq: integer('seq').notNull(),
    deleted: boolean('deleted').notNull().default(false),
    encryptedMeta: jsonb('encrypted_meta').$type<EncryptedBlob>(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index('project_entries_seq_idx').on(t.projectId, t.seq),
  ],
);

/** A secret's value in one environment, sealed with that environment's key. */
export const secretValues = pgTable(
  'secret_values',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    secretId: uuid('secret_id').notNull(),
    environmentId: uuid('environment_id').notNull(),
    encryptedValue: jsonb('encrypted_value').$type<EncryptedBlob>().notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.secretId, t.environmentId] })],
);

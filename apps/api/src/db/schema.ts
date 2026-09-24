import type { DeviceInfo, EncryptedBlob } from '@zvault/shared';
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

// ---------------------------------------------------------------- team access

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'member']);
export const accessLevel = pgEnum('access_level', [
  'manage',
  'edit',
  'use',
  'needs_approval',
  'none',
]);
export const principalType = pgEnum('principal_type', ['account', 'group', 'agent']);
export const accessRequestStatus = pgEnum('access_request_status', [
  'pending',
  'approved',
  'denied',
]);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => accounts.id),
  createdAt: createdAt(),
});

/**
 * Org membership. A member is `invited` until they accept and publish the
 * X25519 sharing key that environment keys are wrapped to (`publicKey` set).
 */
export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    publicKey: text('public_key'),
    invitedBy: uuid('invited_by').references(() => accounts.id, { onDelete: 'set null' }),
    joinedAt: ts('joined_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.accountId] }),
    index('org_members_account_idx').on(t.accountId),
  ],
);

export const orgGroups = pgTable(
  'org_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('org_groups_name_unique').on(t.orgId, t.name)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => orgGroups.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.accountId] }),
    index('group_members_account_idx').on(t.accountId),
  ],
);

/** Agents (e.g. Claude Code on a member's Mac) are principals with their own key. */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agents_org_idx').on(t.orgId)],
);

/**
 * An environment under access control. `environmentId` is the id the projects
 * module gave it; the key version counts rotations.
 */
export const environmentAccess = pgTable(
  'environment_access',
  {
    environmentId: uuid('environment_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    /** Set when a key holder loses access; cleared by the next rotation. */
    rotationRequiredAt: ts('rotation_required_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [index('environment_access_project_idx').on(t.projectId)],
);

export const environmentGrants = pgTable(
  'environment_grants',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environmentAccess.environmentId, { onDelete: 'cascade' }),
    principalType: principalType('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    level: accessLevel('level').notNull(),
    expiresAt: ts('expires_at'),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.principalType, t.principalId] }),
    index('environment_grants_principal_idx').on(t.principalType, t.principalId),
  ],
);

/** Wrapped environment key material; the server can't unwrap any of it. */
export interface StoredWrapBox {
  recipientPublicKey: string;
  wrapperPublicKey: string;
  ephemeralPublicKey: string;
  blob: EncryptedBlob;
}

/** One key version of one environment, wrapped to one member or agent. */
export const environmentKeyWraps = pgTable(
  'environment_key_wraps',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environmentAccess.environmentId, { onDelete: 'cascade' }),
    keyVersion: integer('key_version').notNull(),
    principalType: principalType('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    box: jsonb('box').$type<StoredWrapBox>().notNull(),
    wrappedBy: uuid('wrapped_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.environmentId, t.keyVersion, t.principalType, t.principalId],
    }),
    index('environment_key_wraps_principal_idx').on(t.principalType, t.principalId),
  ],
);

/** Values a manager sealed to the requester when approving. */
export interface StoredRelease {
  approverPublicKey: string;
  ephemeralPublicKey: string;
  blob: EncryptedBlob;
}

/** "Needs approval" requests: each use waits for a manager. */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environmentAccess.environmentId, { onDelete: 'cascade' }),
    requesterType: principalType('requester_type').notNull(),
    requesterId: uuid('requester_id').notNull(),
    requesterPublicKey: text('requester_public_key').notNull(),
    items: jsonb('items').$type<string[]>().notNull(),
    reason: text('reason').notNull(),
    status: accessRequestStatus('status').notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    decidedBy: uuid('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    release: jsonb('release').$type<StoredRelease>(),
    releaseExpiresAt: ts('release_expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('access_requests_env_idx').on(t.environmentId, t.status)],
);

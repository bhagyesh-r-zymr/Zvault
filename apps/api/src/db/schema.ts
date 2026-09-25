import type { DeviceInfo, EncryptedBlob } from '@zvault/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  foreignKey,
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
    /**
     * Set when a manager wrapped the key to this member's sharing key (team
     * access); `wrappedKey` is then the box's ciphertext. Null for the
     * owner's own grants, wrapped with their account key.
     */
    box: jsonb('box').$type<MemberWrapBox>(),
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

/** A project shared with an organization, so its members can be granted access. */
export const projectOrgs = pgTable('project_orgs', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  linkedBy: uuid('linked_by')
    .notNull()
    .references(() => accounts.id),
  createdAt: createdAt(),
});

/**
 * Access state of one environment of an org project. The key version counts
 * rotations; names stay inside the project's ciphertext.
 */
export const environmentAccess = pgTable(
  'environment_access',
  {
    environmentId: uuid('environment_id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    keyVersion: integer('key_version').notNull().default(1),
    /** Set when a key holder loses access; cleared by the next rotation. */
    rotationRequiredAt: ts('rotation_required_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('environment_access_project_idx').on(t.projectId),
    foreignKey({
      columns: [t.projectId, t.environmentId],
      foreignColumns: [projectEntries.projectId, projectEntries.id],
    }).onDelete('cascade'),
  ],
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

/** The public half of a member wrap (see `keyGrants.box`). */
export interface MemberWrapBox {
  recipientPublicKey: string;
  wrapperPublicKey: string;
  ephemeralPublicKey: string;
  /** Environment keys only: the key version the wrap is bound to. */
  keyVersion: number | null;
  wrappedBy: string;
}

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

/**
 * People who asked to try Zvault from the landing page. One row per email;
 * joining again updates the name and note.
 */
export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Normalized (trimmed, lowercased). */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

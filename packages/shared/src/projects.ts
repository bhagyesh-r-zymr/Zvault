import { z } from 'zod';
import { EncryptedBlob } from './crypto.js';
import { RecordId, WrappedKey } from './vault.js';

/**
 * Projects, environments, folders and secrets.
 *
 * ```text
 * account key ──wraps──► project key ──seals──► project, environment, folder and secret metadata
 *             └─wraps──► environment key ──seals──► that environment's secret values
 * ```
 *
 * Every project and every environment has its own random key. A member's
 * access is a set of *key grants*: the project key and each environment key
 * they may use, wrapped for them. The owner's grants are wrapped with their
 * account key (`kid` "account"). Because environment keys are granted one by
 * one, a member can read Development without ever holding the Production key.
 *
 * Names, variable names, folders and tags are all inside ciphertext, so the
 * server sees only ids, revisions and blob sizes. Paths such as
 * `zv://payments-api/production/billing/STRIPE_SECRET_KEY` are resolved on the
 * client after decryption.
 *
 * Every ciphertext is bound (AEAD associated data) to the ids it belongs to;
 * the strings are in `crates/zvault-crypto/src/project.rs` (`aad`).
 */

/** `kid` of a key grant wrapped with the recipient's own account key. */
export const ACCOUNT_KID = 'account';

export const MAX_PROJECTS_PER_ACCOUNT = 200;
export const MAX_ENVIRONMENTS_PER_PROJECT = 20;
export const MAX_FOLDERS_PER_PROJECT = 500;
export const MAX_SECRETS_PER_PROJECT = 10_000;

/** Largest encrypted metadata blob, as base64url characters (~12 KiB). */
export const MAX_META_CT_CHARS = 16 * 1024;
/** Largest encrypted secret value, as base64url characters (~96 KiB). */
export const MAX_VALUE_CT_CHARS = 128 * 1024;

const Meta = EncryptedBlob.refine((b) => b.ct.length <= MAX_META_CT_CHARS, {
  message: 'metadata is too large',
});
const Value = EncryptedBlob.refine((b) => b.ct.length <= MAX_VALUE_CT_CHARS, {
  message: 'value is too large',
});

// ---------------------------------------------------------------------------
// Plaintext shapes. These only ever exist on the client, inside the blobs.
// ---------------------------------------------------------------------------

/** Lowercase letters, digits and single dashes: `payments-api`, `qa-sandbox`. */
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase letters, digits and dashes');
export type Slug = z.infer<typeof Slug>;

/** An environment variable name, as `zv run` exports it. */
export const SecretKeyName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');

/** A tag without its leading `#`. */
export const Tag = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters, digits, dashes or underscores');

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** Sealed with the project key (`aad::project_meta`). */
export const ProjectMeta = z.object({
  name: z.string().min(1).max(100),
  slug: Slug,
  description: z.string().max(1000).optional(),
  color: HexColor.optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;

export const EnvironmentKind = z.enum(['development', 'staging', 'production', 'custom']);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

/** Sealed with the project key (`aad::environment_meta`), so every member sees the list. */
export const EnvironmentMeta = z.object({
  name: z.string().min(1).max(64),
  slug: Slug,
  kind: EnvironmentKind,
  /** Sort order in the environment switcher. */
  position: z.number().int().min(0).max(1000),
  color: HexColor.optional(),
  /**
   * A secret with no value here falls back to this environment's value
   * ("Same as Development"). Resolved on the client; chains end at `null`.
   */
  inheritsFrom: RecordId.nullable().default(null),
});
export type EnvironmentMeta = z.infer<typeof EnvironmentMeta>;

/** Sealed with the project key (`aad::folder_meta`). Folders are one level deep. */
export const FolderMeta = z.object({
  name: z.string().min(1).max(64),
  slug: Slug,
});
export type FolderMeta = z.infer<typeof FolderMeta>;

/**
 * Sealed with the project key (`aad::secret_meta`). The folder lives in here,
 * not on the server record, so the server can't see how secrets are grouped.
 */
export const SecretMeta = z.object({
  /** Display name: "Stripe secret key". */
  name: z.string().min(1).max(200),
  /** Variable name, also the last path segment: `STRIPE_SECRET_KEY`. */
  key: SecretKeyName,
  folderId: RecordId.nullable().default(null),
  tags: z.array(Tag).max(32).default([]),
  note: z.string().max(4000).optional(),
});
export type SecretMeta = z.infer<typeof SecretMeta>;

/** Sealed with an environment key (`aad::secret_value`). */
export const SecretValue = z.object({
  value: z.string().max(64 * 1024),
});
export type SecretValue = z.infer<typeof SecretValue>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface SecretPath {
  project: string;
  environment: string;
  /** `null` for a secret at the top of the project. */
  folder: string | null;
  key: string;
}

const PATH = /^zv:\/\/([^/]+)\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/;

/** Parses `zv://<project>/<environment>/[<folder>/]<KEY>`; `null` if malformed. */
export function parseSecretPath(path: string): SecretPath | null {
  const m = PATH.exec(path);
  if (!m) return null;
  const [, project, environment, folder, key] = m;
  const ok =
    Slug.safeParse(project).success &&
    Slug.safeParse(environment).success &&
    (folder === undefined || Slug.safeParse(folder).success) &&
    SecretKeyName.safeParse(key).success;
  return ok
    ? { project: project!, environment: environment!, folder: folder ?? null, key: key! }
    : null;
}

export function formatSecretPath({ project, environment, folder, key }: SecretPath): string {
  return `zv://${project}/${environment}/${folder ? `${folder}/` : ''}${key}`;
}

/** Turns a display name into a slug: "Payments API" → `payments-api`. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Wire records
// ---------------------------------------------------------------------------

export const ProjectRecord = z.object({
  id: RecordId,
  revision: z.number().int().min(1),
  /** Project metadata sealed with the project key; `kid` is the project id. */
  encryptedMeta: Meta,
  /** The project key wrapped for the caller (their key grant). */
  encryptedKey: WrappedKey,
  /** Whether the caller owns the project. */
  owner: z.boolean(),
  /** Project-wide change sequence; compare with a stored cursor to skip a sync. */
  seq: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const ListProjectsResponse = z.object({ projects: z.array(ProjectRecord) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;

const NewEnvironment = z.object({
  id: RecordId,
  /** Environment metadata sealed with the project key; `kid` is the environment id. */
  encryptedMeta: Meta,
  /** Environment key wrapped with the creator's account key; `kid` is `account`. */
  encryptedKey: WrappedKey,
});

/** Creates a project, optionally with its first environments, in one step. New projects in the app start with none. */
export const CreateProjectRequest = z.object({
  id: RecordId,
  encryptedMeta: Meta,
  /** Project key wrapped with the creator's account key; `kid` is `account`. */
  encryptedKey: WrappedKey,
  environments: z.array(NewEnvironment).max(MAX_ENVIRONMENTS_PER_PROJECT),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({
  baseRevision: z.number().int().min(1),
  encryptedMeta: Meta,
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/**
 * Creates or updates an environment. `encryptedKey` is required on create
 * (baseRevision 0) and ignored afterwards: rotating an environment key means
 * re-sealing its values, which is a separate operation.
 */
export const PutEnvironmentRequest = z.object({
  baseRevision: z.number().int().min(0),
  encryptedMeta: Meta,
  encryptedKey: WrappedKey.optional(),
});
export type PutEnvironmentRequest = z.infer<typeof PutEnvironmentRequest>;

export const PutFolderRequest = z.object({
  baseRevision: z.number().int().min(0),
  encryptedMeta: Meta,
});
export type PutFolderRequest = z.infer<typeof PutFolderRequest>;

/**
 * Creates or updates a secret. `values` maps environment ids to the value
 * sealed with that environment's key (`kid` = environment id), or `null` to
 * clear it. Environments left out keep their current value, so a member who
 * holds only some environment keys can still edit the secret.
 */
export const PutSecretRequest = z.object({
  baseRevision: z.number().int().min(0),
  encryptedMeta: Meta,
  values: z
    .record(RecordId, Value.nullable())
    .refine((v) => Object.keys(v).length <= MAX_ENVIRONMENTS_PER_PROJECT, {
      message: 'too many environments',
    })
    .default({}),
});
export type PutSecretRequest = z.infer<typeof PutSecretRequest>;

export const DeleteEntryQuery = z.object({
  baseRevision: z.coerce.number().int().min(1),
});

const EntryBase = z.object({
  id: RecordId,
  projectId: RecordId,
  /** Increases by one on every write; used for optimistic concurrency. */
  revision: z.number().int().min(1),
  /** Project-wide change sequence number; used as the sync cursor. */
  seq: z.number().int().min(1),
  updatedAt: z.iso.datetime(),
});

export const EnvironmentEntry = EntryBase.extend({
  type: z.literal('environment'),
  deleted: z.literal(false),
  encryptedMeta: Meta,
  /** The environment key wrapped for the caller, or `null` if they have no access to its values. */
  encryptedKey: WrappedKey.nullable(),
});

export const FolderEntry = EntryBase.extend({
  type: z.literal('folder'),
  deleted: z.literal(false),
  encryptedMeta: Meta,
});

export const SecretValueRecord = z.object({
  environmentId: RecordId,
  encryptedValue: Value,
  updatedAt: z.iso.datetime(),
});
export type SecretValueRecord = z.infer<typeof SecretValueRecord>;

export const SecretEntry = EntryBase.extend({
  type: z.literal('secret'),
  deleted: z.literal(false),
  encryptedMeta: Meta,
  /** Only values of environments the caller holds a key grant for. */
  values: z.array(SecretValueRecord),
});

/** A deleted environment, folder or secret, kept so other devices learn about it on sync. */
export const DeletedEntry = EntryBase.extend({
  type: z.enum(['environment', 'folder', 'secret']),
  deleted: z.literal(true),
});

export const ProjectEntry = z.union([EnvironmentEntry, FolderEntry, SecretEntry, DeletedEntry]);
export type ProjectEntry = z.infer<typeof ProjectEntry>;
export type EnvironmentEntry = z.infer<typeof EnvironmentEntry>;
export type FolderEntry = z.infer<typeof FolderEntry>;
export type SecretEntry = z.infer<typeof SecretEntry>;
export type DeletedEntry = z.infer<typeof DeletedEntry>;
export type EntryType = DeletedEntry['type'];

export const MAX_PROJECT_SYNC_PAGE = 500;

export const SyncProjectQuery = z.object({
  /** Return changes after this cursor; 0 for a full sync. */
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PROJECT_SYNC_PAGE).default(MAX_PROJECT_SYNC_PAGE),
});

export const SyncProjectResponse = z.object({
  entries: z.array(ProjectEntry),
  /** Pass back as `since` on the next call. */
  cursor: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type SyncProjectResponse = z.infer<typeof SyncProjectResponse>;

export const EntryConflictResponse = z.object({
  error: z.literal('conflict'),
  current: ProjectEntry,
});
export type EntryConflictResponse = z.infer<typeof EntryConflictResponse>;

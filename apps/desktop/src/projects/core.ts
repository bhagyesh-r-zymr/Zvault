import { invoke } from '@tauri-apps/api/core';
import type {
  AddEnvironmentWrapsRequest,
  AddProjectWrapsRequest,
  ApproveAccessRequest,
  CreateProjectRequest,
  EncryptedBlob,
  EnvironmentMeta,
  FolderMeta,
  ProjectMeta,
  PendingWrap,
  RotateEnvironmentKeyRequest,
  SecretMeta,
  StoredMemberWrap,
} from '@zvault/shared';

/**
 * Typed bridge to the project commands in the Rust core. Project and
 * environment keys never leave Rust: these calls seal plaintext metadata into
 * blobs for the API, and open blobs from the API back into metadata. Results
 * are `unknown` where Rust returns decrypted JSON; callers validate them with
 * the zod schemas in `@zvault/shared`.
 */

export interface ProjectCipher {
  id: string;
  encryptedKey: EncryptedBlob;
  encryptedMeta: EncryptedBlob;
}

/** `encryptedKey` is absent (or null from the API) for environments without a key grant. */
export interface EnvironmentCipher {
  id: string;
  encryptedMeta: EncryptedBlob;
  encryptedKey?: EncryptedBlob | null;
}

export interface EnvironmentView {
  meta: unknown;
  /** Whether this account holds the key, i.e. can read and write its values. */
  unlocked: boolean;
}

export type EntryKind = 'folder' | 'secret';

export interface SealedEntry {
  id: string;
  encryptedMeta: EncryptedBlob;
}

export interface ProjectsCore {
  /** A new project with fresh keys, in the shape `POST /projects` takes. */
  createProject(meta: ProjectMeta, environments: EnvironmentMeta[]): Promise<CreateProjectRequest>;
  /**
   * Unwraps the project key into the keyring and returns its metadata. For a
   * project shared through an org, pass the caller's wrap from
   * `GET /access/projects/:id/keys/me`.
   */
  openProject(project: ProjectCipher, memberWrap?: StoredMemberWrap | null): Promise<unknown>;
  openEnvironment(
    projectId: string,
    environment: EnvironmentCipher,
    memberWrap?: StoredMemberWrap | null,
  ): Promise<EnvironmentView>;
  /** Without an id this creates an environment with a fresh key. */
  sealEnvironment(
    projectId: string,
    id: string | null,
    meta: EnvironmentMeta,
  ): Promise<EnvironmentCipher>;
  sealEntry(
    projectId: string,
    kind: EntryKind,
    id: string | null,
    meta: FolderMeta | SecretMeta,
  ): Promise<SealedEntry>;
  openEntry(
    projectId: string,
    kind: EntryKind,
    id: string,
    encryptedMeta: EncryptedBlob,
  ): Promise<unknown>;
  sealValue(
    projectId: string,
    secretId: string,
    environmentId: string,
    value: string,
  ): Promise<EncryptedBlob>;
  /** Decrypts one value to reveal or copy. Never keep or log the result. */
  openValue(
    projectId: string,
    secretId: string,
    environmentId: string,
    encryptedValue: EncryptedBlob,
  ): Promise<string>;
}

export const projectsCore: ProjectsCore = {
  createProject: (meta, environments) => invoke('project_create', { meta, environments }),
  openProject: (project, memberWrap) =>
    invoke('project_open', { project, memberWrap: memberWrap ?? null }),
  openEnvironment: (projectId, environment, memberWrap) =>
    invoke('environment_open', { projectId, environment, memberWrap: memberWrap ?? null }),
  sealEnvironment: (projectId, id, meta) => invoke('environment_seal', { projectId, id, meta }),
  sealEntry: (projectId, kind, id, meta) => invoke('entry_seal', { projectId, kind, id, meta }),
  openEntry: (projectId, kind, id, encryptedMeta) =>
    invoke('entry_open', { projectId, kind, id, encryptedMeta }),
  sealValue: (projectId, secretId, environmentId, value) =>
    invoke('secret_value_seal', { projectId, secretId, environmentId, value }),
  openValue: (projectId, secretId, environmentId, encryptedValue) =>
    invoke('secret_value_open', { projectId, secretId, environmentId, encryptedValue }),
};

/** A value an approver releases, as its ciphertext from the project sync. */
export interface ReleaseItem {
  /** The reference the requester asked for, e.g. `zv://payments-api/production/stripe/key`. */
  item: string;
  secretId: string;
  environmentId: string;
  encryptedValue: EncryptedBlob;
}

export interface ReleasedValue {
  item: string;
  value: string;
}

/**
 * Key handling for team access, done in Rust with this account's sharing
 * key. Each call returns the body for the matching access route unchanged.
 */
export interface TeamKeysCore {
  /** Body of `POST /access/projects/:id/keys`. The project must be open. */
  wrapProjectKey(projectId: string, recipients: PendingWrap[]): Promise<AddProjectWrapsRequest>;
  /** Body of `POST /access/environments/:id/keys`. The environment must be unlocked. */
  wrapEnvironmentKey(
    projectId: string,
    environmentId: string,
    keyVersion: number,
    recipients: PendingWrap[],
  ): Promise<AddEnvironmentWrapsRequest>;
  /**
   * Body of `POST /access/environments/:id/rotate`: every value re-sealed
   * under a fresh key, wrapped to `recipients` (everyone who keeps access,
   * this account included). Call {@link TeamKeysCore.commitRotation} once the
   * API accepts it.
   */
  rotateEnvironment(
    projectId: string,
    environmentId: string,
    fromVersion: number,
    recipients: PendingWrap[],
    values: { secretId: string; encryptedValue: EncryptedBlob }[],
  ): Promise<RotateEnvironmentKeyRequest>;
  commitRotation(projectId: string, environmentId: string): Promise<boolean>;
  /** Body of `POST /access/requests/:id/approve`: the values sealed to the requester. */
  sealRelease(
    projectId: string,
    requestId: string,
    requesterPublicKey: string,
    items: ReleaseItem[],
  ): Promise<ApproveAccessRequest>;
  /** Opens a release sent to this account. Never keep or log the result. */
  openRelease(requestId: string, release: ApproveAccessRequest): Promise<ReleasedValue[]>;
}

export const teamKeysCore: TeamKeysCore = {
  wrapProjectKey: (projectId, recipients) => invoke('project_key_wrap', { projectId, recipients }),
  wrapEnvironmentKey: (projectId, environmentId, keyVersion, recipients) =>
    invoke('environment_key_wrap', { projectId, environmentId, keyVersion, recipients }),
  rotateEnvironment: (projectId, environmentId, fromVersion, recipients, values) =>
    invoke('environment_rotate', { projectId, environmentId, fromVersion, recipients, values }),
  commitRotation: (projectId, environmentId) =>
    invoke('environment_rotate_commit', { projectId, environmentId }),
  sealRelease: (projectId, requestId, requesterPublicKey, items) =>
    invoke('access_release_seal', { projectId, requestId, requesterPublicKey, items }),
  openRelease: (requestId, release) => invoke('access_release_open', { requestId, release }),
};

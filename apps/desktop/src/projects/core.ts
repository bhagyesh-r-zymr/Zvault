import { invoke } from '@tauri-apps/api/core';
import type {
  CreateProjectRequest,
  EncryptedBlob,
  EnvironmentMeta,
  FolderMeta,
  ProjectMeta,
  SecretMeta,
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
  /** Unwraps the project key into the keyring and returns its metadata. */
  openProject(project: ProjectCipher): Promise<unknown>;
  openEnvironment(projectId: string, environment: EnvironmentCipher): Promise<EnvironmentView>;
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
  openProject: (project) => invoke('project_open', { project }),
  openEnvironment: (projectId, environment) =>
    invoke('environment_open', { projectId, environment }),
  sealEnvironment: (projectId, id, meta) => invoke('environment_seal', { projectId, id, meta }),
  sealEntry: (projectId, kind, id, meta) => invoke('entry_seal', { projectId, kind, id, meta }),
  openEntry: (projectId, kind, id, encryptedMeta) =>
    invoke('entry_open', { projectId, kind, id, encryptedMeta }),
  sealValue: (projectId, secretId, environmentId, value) =>
    invoke('secret_value_seal', { projectId, secretId, environmentId, value }),
  openValue: (projectId, secretId, environmentId, encryptedValue) =>
    invoke('secret_value_open', { projectId, secretId, environmentId, encryptedValue }),
};

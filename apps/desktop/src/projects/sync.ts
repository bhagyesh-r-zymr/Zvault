import {
  DEFAULT_ENVIRONMENTS,
  EnvironmentMeta,
  FolderMeta,
  MEMBER_KEY_WRAP_KID,
  ProjectMeta,
  SecretMeta,
  slugify,
  type EncryptedBlob,
  type MyProjectKeysResponse,
  type ProjectEntry,
  type ProjectRecord,
} from '@zvault/shared';
import { EntryConflictError, type ProjectsApi } from './api.js';
import type { ProjectsCore } from './core.js';
import { toView, uniqueSlug, type ProjectState, type ProjectsView } from './model.js';

export interface ProjectsSnapshot extends ProjectsView {
  status: 'loading' | 'ready' | 'failed';
  error: string | null;
  /** Projects or entries whose ciphertext could not be decrypted. */
  unreadable: number;
}

export interface NewSecret {
  name: string;
  key: string;
  folderId: string | null;
  tags: string[];
  note?: string;
  /** Plaintext value per environment id. Sealed in Rust before it leaves. */
  values: Record<string, string>;
}

interface Tracked extends ProjectState {
  cursor: number;
  /** For a project someone shared with this account: its member wraps. */
  wraps: MyProjectKeysResponse | null;
}

/**
 * Local view of every project the account can open, kept in step with the
 * server. Metadata is decrypted as it syncs; secret values stay sealed until
 * {@link ProjectsSync.openValue} is called for one.
 *
 * Writes use optimistic concurrency like the vault: a write that lost a race
 * surfaces as an {@link EntryConflictError} after the winning version has
 * been applied locally.
 */
export class ProjectsSync {
  private readonly projects = new Map<string, Tracked>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ProjectsSnapshot = {
    status: 'loading',
    error: null,
    unreadable: 0,
    projects: [],
    secrets: [],
  };
  private unreadable = 0;

  constructor(
    private readonly api: ProjectsApi,
    private readonly core: ProjectsCore,
  ) {}

  get = (): ProjectsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Lists the account's projects, opens each and pulls its entries. */
  async load(): Promise<void> {
    try {
      const records = await this.api.listProjects();
      const live = new Set(records.map((r) => r.id));
      for (const id of this.projects.keys()) if (!live.has(id)) this.projects.delete(id);
      for (const record of records) {
        if (!(await this.open(record))) continue;
        await this.pull(record.id);
      }
      this.emit('ready', null);
    } catch (e) {
      this.emit('failed', e instanceof Error ? e.message : 'Projects could not be loaded.');
    }
  }

  /** Fetches every change to one project since its last pull. */
  async pull(projectId: string): Promise<void> {
    const project = this.project(projectId);
    let hasMore = true;
    while (hasMore) {
      const page = await this.api.syncProject(projectId, project.cursor);
      for (const entry of page.entries) await this.apply(project, entry);
      project.cursor = page.cursor;
      hasMore = page.hasMore;
    }
    this.emit();
  }

  /** Creates a project with the default environments. Returns its id. */
  async createProject(name: string): Promise<string> {
    const taken = [...this.projects.values()].map((p) => p.meta.slug);
    const meta = ProjectMeta.parse({
      name: name.trim(),
      slug: uniqueSlug(slugify(name) || 'project', taken),
    });
    const environments = DEFAULT_ENVIRONMENTS.map((e, position) =>
      EnvironmentMeta.parse({ ...e, position }),
    );
    const request = await this.core.createProject(meta, environments);
    const record = await this.api.createProject(request);
    this.projects.set(record.id, blank(record, meta));
    await this.pull(record.id);
    return record.id;
  }

  /** Adds an environment with a fresh key (owners only). Returns its id. */
  async createEnvironment(projectId: string, name: string): Promise<string> {
    const project = this.project(projectId);
    const envs = [...project.environments.values()].map((e) => e.meta);
    const meta = EnvironmentMeta.parse({
      name: name.trim(),
      slug: uniqueSlug(
        slugify(name) || 'environment',
        envs.map((e) => e.slug),
      ),
      kind: 'custom',
      position: Math.min(1000, Math.max(-1, ...envs.map((e) => e.position)) + 1),
    });
    const sealed = await this.core.sealEnvironment(projectId, null, meta);
    const entry = await this.write(project, () =>
      this.api.putEnvironment(projectId, sealed.id, {
        baseRevision: 0,
        encryptedMeta: sealed.encryptedMeta,
        ...(sealed.encryptedKey && { encryptedKey: sealed.encryptedKey }),
      }),
    );
    return entry.id;
  }

  /** Adds a folder (owners only). Returns its id. */
  async createFolder(projectId: string, name: string): Promise<string> {
    const project = this.project(projectId);
    const meta = FolderMeta.parse({
      name: name.trim(),
      slug: uniqueSlug(
        slugify(name) || 'folder',
        [...project.folders.values()].map((f) => f.meta.slug),
      ),
    });
    const sealed = await this.core.sealEntry(projectId, 'folder', null, meta);
    const entry = await this.write(project, () =>
      this.api.putFolder(projectId, sealed.id, {
        baseRevision: 0,
        encryptedMeta: sealed.encryptedMeta,
      }),
    );
    return entry.id;
  }

  /** Seals a new secret's metadata and each value, then uploads it. Returns its id. */
  async createSecret(projectId: string, secret: NewSecret): Promise<string> {
    const project = this.project(projectId);
    const meta = SecretMeta.parse({
      name: secret.name.trim(),
      key: secret.key,
      folderId: secret.folderId,
      tags: secret.tags,
      ...(secret.note && { note: secret.note }),
    });
    const sealed = await this.core.sealEntry(projectId, 'secret', null, meta);
    const values: Record<string, EncryptedBlob> = {};
    for (const [envId, value] of Object.entries(secret.values)) {
      values[envId] = await this.core.sealValue(projectId, sealed.id, envId, value);
    }
    const entry = await this.write(project, () =>
      this.api.putSecret(projectId, sealed.id, {
        baseRevision: 0,
        encryptedMeta: sealed.encryptedMeta,
        values,
      }),
    );
    return entry.id;
  }

  /**
   * Uploads one environment's value that the Rust core already sealed, for
   * `zv set`. A new secret arrives with its sealed metadata; an existing one
   * keeps its metadata, re-sealed here because every write carries it.
   */
  async putSealedValue(write: {
    projectId: string;
    secretId: string;
    environmentId: string;
    encryptedValue: EncryptedBlob;
    encryptedMeta: EncryptedBlob | null;
  }): Promise<void> {
    const { projectId, secretId, environmentId } = write;
    await this.pull(projectId);
    const project = this.project(projectId);
    const existing = project.secrets.get(secretId);
    let encryptedMeta = write.encryptedMeta;
    if (!encryptedMeta) {
      if (!existing) throw new Error('This secret is no longer available.');
      encryptedMeta = (await this.core.sealEntry(projectId, 'secret', secretId, existing.meta))
        .encryptedMeta;
    }
    const body = {
      baseRevision: existing?.revision ?? 0,
      encryptedMeta,
      values: { [environmentId]: write.encryptedValue },
    };
    await this.write(project, () => this.api.putSecret(projectId, secretId, body));
  }

  async deleteSecret(projectId: string, secretId: string): Promise<void> {
    const project = this.project(projectId);
    const secret = project.secrets.get(secretId);
    if (!secret) return;
    await this.write(project, () =>
      this.api.deleteEntry(projectId, 'secret', secretId, secret.revision),
    );
  }

  /**
   * Decrypts the value one environment holds for a secret, to reveal or copy.
   * The caller passes the environment that actually holds it (see `valueSource`).
   */
  openValue(projectId: string, secretId: string, environmentId: string): Promise<string> {
    const blob = this.projects.get(projectId)?.secrets.get(secretId)?.values[environmentId];
    if (!blob) return Promise.reject(new Error('This value is not available.'));
    return this.core.openValue(projectId, secretId, environmentId, blob);
  }

  private async write(project: Tracked, send: () => Promise<ProjectEntry>): Promise<ProjectEntry> {
    try {
      const entry = await send();
      await this.apply(project, entry);
      return entry;
    } catch (e) {
      if (e instanceof EntryConflictError) await this.apply(project, e.current);
      throw e;
    } finally {
      this.emit();
    }
  }

  private project(projectId: string): Tracked {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('This project is no longer available.');
    return project;
  }

  /** Unwraps a project's key and decrypts its metadata; `false` if it can't. */
  private async open(record: ProjectRecord): Promise<boolean> {
    try {
      const wraps =
        record.encryptedKey.kid === MEMBER_KEY_WRAP_KID ? await this.api.myKeys(record.id) : null;
      const meta = ProjectMeta.parse(await this.core.openProject(record, wraps?.projectKey));
      const known = this.projects.get(record.id);
      if (known) {
        Object.assign(known, { meta, revision: record.revision, owner: record.owner, wraps });
      } else {
        this.projects.set(record.id, { ...blank(record, meta), wraps });
      }
      return true;
    } catch {
      this.projects.delete(record.id);
      this.unreadable += 1;
      return false;
    }
  }

  private async apply(project: Tracked, entry: ProjectEntry): Promise<void> {
    const maps = {
      environment: project.environments,
      folder: project.folders,
      secret: project.secrets,
    } as const;
    const known = maps[entry.type].get(entry.id);
    if (known && known.revision >= entry.revision) return;
    if (entry.deleted) {
      maps[entry.type].delete(entry.id);
      return;
    }
    const pid = project.id;
    try {
      switch (entry.type) {
        case 'environment': {
          const wrap = project.wraps?.environments.find((e) => e.environmentId === entry.id)?.wrap;
          const view = await this.core.openEnvironment(pid, entry, wrap);
          project.environments.set(entry.id, {
            revision: entry.revision,
            meta: EnvironmentMeta.parse(view.meta),
            unlocked: view.unlocked,
          });
          break;
        }
        case 'folder': {
          const meta = await this.core.openEntry(pid, 'folder', entry.id, entry.encryptedMeta);
          project.folders.set(entry.id, { revision: entry.revision, meta: FolderMeta.parse(meta) });
          break;
        }
        case 'secret': {
          const meta = await this.core.openEntry(pid, 'secret', entry.id, entry.encryptedMeta);
          project.secrets.set(entry.id, {
            revision: entry.revision,
            meta: SecretMeta.parse(meta),
            values: Object.fromEntries(
              entry.values.map((v) => [v.environmentId, v.encryptedValue]),
            ),
          });
          break;
        }
      }
    } catch {
      this.unreadable += 1;
    }
  }

  private emit(status = this.snapshot.status, error = this.snapshot.error): void {
    this.snapshot = {
      status,
      error,
      unreadable: this.unreadable,
      ...toView(this.projects.values()),
    };
    for (const listener of this.listeners) listener();
  }
}

function blank(record: ProjectRecord, meta: ProjectMeta): Tracked {
  return {
    id: record.id,
    revision: record.revision,
    owner: record.owner,
    meta,
    cursor: 0,
    wraps: null,
    environments: new Map(),
    folders: new Map(),
    secrets: new Map(),
  };
}

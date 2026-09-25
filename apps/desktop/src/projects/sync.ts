import {
  EnvironmentMeta,
  FolderMeta,
  MEMBER_KEY_WRAP_KID,
  ProjectMeta,
  SecretMeta,
  Slug,
  slugify,
  type EnvironmentKind,
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

/** What a person picks for an environment; the slug defaults to one made from the name. */
export interface EnvironmentDraft {
  name: string;
  slug?: string;
  kind?: EnvironmentKind;
  /** Where a secret with no value here takes it from. */
  inheritsFrom?: string | null;
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

  /**
   * Creates a project. It starts with no environments unless some are given;
   * people add their own afterwards. Returns its id.
   */
  async createProject(name: string, environments: EnvironmentDraft[] = []): Promise<string> {
    const taken = [...this.projects.values()].map((p) => p.meta.slug);
    const meta = ProjectMeta.parse({
      name: name.trim(),
      slug: uniqueSlug(slugify(name) || 'project', taken),
    });
    const envs: EnvironmentMeta[] = [];
    for (const draft of environments) envs.push(environmentMeta(draft, envs, envs.length));
    const request = await this.core.createProject(meta, envs);
    const record = await this.api.createProject(request);
    this.projects.set(record.id, blank(record, meta));
    await this.pull(record.id);
    return record.id;
  }

  /** Adds an environment with a fresh key (owners and org admins). Returns its id. */
  async createEnvironment(projectId: string, draft: string | EnvironmentDraft): Promise<string> {
    const project = this.project(projectId);
    const envs = [...project.environments.values()].map((e) => e.meta);
    const meta = environmentMeta(
      typeof draft === 'string' ? { name: draft } : draft,
      envs,
      Math.min(1000, Math.max(-1, ...envs.map((e) => e.position)) + 1),
    );
    if (meta.inheritsFrom && !project.environments.has(meta.inheritsFrom)) {
      throw new Error('That environment is no longer available.');
    }
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

  /**
   * Renames an environment, changes its slug, kind or fallback. Only its
   * metadata is re-sealed; its key and values stay as they are.
   */
  async updateEnvironment(
    projectId: string,
    envId: string,
    changes: Required<Pick<EnvironmentDraft, 'name' | 'slug'>> & EnvironmentDraft,
  ): Promise<void> {
    const project = this.project(projectId);
    const current = project.environments.get(envId);
    if (!current) throw new Error('This environment is no longer available.');
    const others = [...project.environments].filter(([id]) => id !== envId);
    const slug = changes.slug.trim();
    if (!Slug.safeParse(slug).success) {
      throw new Error('Use lowercase letters, digits and single dashes in the slug.');
    }
    if (others.some(([, e]) => e.meta.slug === slug)) {
      throw new Error(`Another environment already uses “${slug}”.`);
    }
    const inheritsFrom =
      changes.inheritsFrom === undefined ? current.meta.inheritsFrom : changes.inheritsFrom;
    if (inheritsFrom) {
      // Follow the chain from the new source; reaching this one would loop.
      const seen = new Set<string>();
      for (let id: string | null = inheritsFrom; id;) {
        if (id === envId || seen.has(id)) {
          throw new Error('That would make these environments fall back to each other.');
        }
        seen.add(id);
        id = project.environments.get(id)?.meta.inheritsFrom ?? null;
      }
      if (!project.environments.has(inheritsFrom)) {
        throw new Error('That environment is no longer available.');
      }
    }
    const meta = EnvironmentMeta.parse({
      ...current.meta,
      name: changes.name.trim(),
      slug,
      kind: changes.kind ?? current.meta.kind,
      inheritsFrom,
    });
    await this.saveEnvironment(project, envId, current.revision, meta);
  }

  /**
   * Deletes an environment with its key and every value sealed with it.
   * Environments that fell back to it fall back to what it fell back to, and
   * secrets left with no value anywhere are deleted too.
   */
  async deleteEnvironment(projectId: string, envId: string): Promise<void> {
    const project = this.project(projectId);
    const env = project.environments.get(envId);
    if (!env) return;
    const orphans = orphanedBy(project, envId);
    for (const [id, other] of project.environments) {
      if (other.meta.inheritsFrom !== envId) continue;
      const parent = env.meta.inheritsFrom === id ? null : env.meta.inheritsFrom;
      await this.saveEnvironment(project, id, other.revision, {
        ...other.meta,
        inheritsFrom: parent,
      });
    }
    await this.write(project, () =>
      this.api.deleteEntry(projectId, 'environment', envId, env.revision),
    );
    for (const secretId of orphans) {
      const secret = project.secrets.get(secretId);
      if (!secret) continue;
      await this.write(project, () =>
        this.api.deleteEntry(projectId, 'secret', secretId, secret.revision),
      );
    }
  }

  /** Secrets that would have no value left if `envId` went; see {@link orphanedBy}. */
  secretsOnlyIn(projectId: string, envId: string): string[] {
    const project = this.projects.get(projectId);
    return project ? orphanedBy(project, envId) : [];
  }

  private async saveEnvironment(
    project: Tracked,
    envId: string,
    revision: number,
    meta: EnvironmentMeta,
  ): Promise<void> {
    const sealed = await this.core.sealEnvironment(project.id, envId, meta);
    await this.write(project, () =>
      this.api.putEnvironment(project.id, envId, {
        baseRevision: revision,
        encryptedMeta: sealed.encryptedMeta,
      }),
    );
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
    if (known && known.revision > entry.revision) return;
    // A key rotation re-sends the environment and its values at the same
    // revision, with a new key and re-sealed values; apply those again.
    const rekeyed =
      !entry.deleted &&
      (entry.type === 'environment' ||
        (entry.type === 'secret' &&
          entry.values.some(
            (v) =>
              project.secrets.get(entry.id)?.values[v.environmentId]?.ct !== v.encryptedValue.ct,
          )));
    if (known && known.revision === entry.revision && !rekeyed) return;
    if (entry.deleted) {
      maps[entry.type].delete(entry.id);
      // The server dropped the environment's values without re-sending each secret.
      if (entry.type === 'environment') {
        for (const secret of project.secrets.values()) delete secret.values[entry.id];
      }
      return;
    }
    const pid = project.id;
    try {
      switch (entry.type) {
        case 'environment': {
          const wrapOf = () =>
            project.wraps?.environments.find((e) => e.environmentId === entry.id)?.wrap;
          // The key was wrapped to this account by a manager (after a rotation
          // even the owner's is): fetch the current wraps when ours is missing
          // or may be for the previous key.
          if (
            entry.encryptedKey?.kid === MEMBER_KEY_WRAP_KID &&
            (!wrapOf() || known?.revision === entry.revision)
          ) {
            project.wraps = await this.api.myKeys(pid).catch(() => project.wraps);
          }
          const view = await this.core.openEnvironment(pid, entry, wrapOf());
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

/** Metadata for a new environment, with a slug no other environment uses. */
function environmentMeta(
  draft: EnvironmentDraft,
  existing: EnvironmentMeta[],
  position: number,
): EnvironmentMeta {
  const name = draft.name.trim();
  const taken = existing.map((e) => e.slug);
  const slug = draft.slug?.trim();
  if (slug !== undefined && slug !== '') {
    if (!Slug.safeParse(slug).success) {
      throw new Error('Use lowercase letters, digits and single dashes in the slug.');
    }
    if (taken.includes(slug)) throw new Error(`Another environment already uses “${slug}”.`);
  }
  return EnvironmentMeta.parse({
    name,
    slug: slug || uniqueSlug(slugify(name) || 'environment', taken),
    kind: draft.kind ?? 'custom',
    position,
    inheritsFrom: draft.inheritsFrom ?? null,
  });
}

/**
 * Secrets whose only value is in `envId`. When this account can't read some
 * other environment, a secret may have a value there, so it is left alone.
 */
function orphanedBy(project: ProjectState, envId: string): string[] {
  const others = [...project.environments].filter(([id]) => id !== envId);
  if (others.some(([, e]) => !e.unlocked)) return [];
  return [...project.secrets]
    .filter(([, s]) => s.values[envId] && others.every(([id]) => !s.values[id]))
    .map(([id]) => id);
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

import { parseSecretPath, type EnvironmentKind } from '@zvault/shared';
import {
  secretRef,
  valueSource,
  type Environment,
  type Project,
  type ProjectSecret,
} from '../projects/model.js';
import type { ProjectsSync } from '../projects/sync.js';
import type { VaultApi } from '../vault/api.js';
import type { VaultCore } from '../vault/core.js';
import { openDefaultVault, VaultSync } from '../vault/sync.js';
import {
  agents,
  type ApplyChange,
  type Change,
  type FindSecret,
  type HandleItem,
  type ListSecrets,
  type ProjectInfo,
  type SaveSecret,
} from './api.js';

/**
 * Answers the Rust core's `zv` requests from the synced projects and the
 * personal vault, so `zv read`, `run`, `ls`, `env`, `set`, the project,
 * environment and folder commands and `zv item` work on real data. Only
 * ciphertext passes through here: Rust decrypts values for the CLI and seals
 * what `zv set` and `zv item` write. Each request first pulls the latest
 * changes. Rust has already had the person approve every change it passes on.
 *
 * Returns a function that stops answering.
 */
export function serveZv(
  sync: ProjectsSync,
  vault?: { api: VaultApi; core: VaultCore },
): () => void {
  const ready = async () => {
    if (sync.get().status !== 'ready') await sync.load();
    return sync.get();
  };

  const find: FindSecret = async (reference) => {
    const path = parseSecretPath(reference);
    if (!path) return null;
    let view = await ready();
    let project = view.projects.find((p) => p.slug === path.project);
    if (!project) return null;
    await sync.pull(project.id);
    view = sync.get();
    project = view.projects.find((p) => p.id === project!.id);
    const env = project?.environments.find((e) => e.slug === path.environment);
    if (!project || !env || env.locked) return null;
    const folder = path.folder ? project.folders.find((f) => f.slug === path.folder) : null;
    if (folder === undefined) return null;
    const secret = view.secrets.find(
      (s) =>
        s.projectId === project.id &&
        s.key === path.key &&
        (s.folder?.id ?? null) === (folder?.id ?? null),
    );
    const source = secret ? valueSource(project, secret, env.id) : null;
    return {
      projectId: project.id,
      environmentId: env.id,
      secretId: secret?.id ?? null,
      folderId: folder?.id ?? null,
      encryptedValue: source ? (secret?.values[source] ?? null) : null,
      valueEnvironmentId: source,
    };
  };

  const pullAll = async () => {
    await ready();
    await Promise.all(sync.get().projects.map((p) => sync.pull(p.id).catch(() => undefined)));
    return sync.get();
  };

  const list: ListSecrets = async (prefix) => {
    const { projects, secrets } = await pullAll();
    const under = prefix?.replace(/\*$/, '') ?? '';
    const refs: string[] = [];
    for (const project of projects) {
      for (const env of project.environments) {
        if (env.locked) continue;
        for (const secret of secrets) {
          if (secret.projectId !== project.id || !valueSource(project, secret, env.id)) continue;
          const ref = secretRef(project, env, secret);
          if (ref.startsWith(under)) refs.push(ref);
        }
      }
    }
    return refs;
  };

  const save: SaveSecret = (write) => sync.putSealedValue(write);

  const describe = async (): Promise<ProjectInfo[]> => {
    const { projects } = await pullAll();
    return projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      owner: p.owner,
      environments: p.environments.map((e) => ({
        slug: e.slug,
        name: e.name,
        kind: e.kind,
        inheritsFrom: p.environments.find((x) => x.id === e.inheritsFrom)?.slug ?? null,
        locked: e.locked,
      })),
      folders: p.folders.map((f) => ({ slug: f.slug, name: f.name })),
    }));
  };

  const apply: ApplyChange = (change) => applyChange(sync, ready, change);

  let vaultSync: VaultSync | null = null;
  const openVault = async (): Promise<VaultSync> => {
    if (!vault) throw new Error('The vault is not available in this window.');
    // Opening again after a lock puts the vault key back in the keyring.
    const summary = await openDefaultVault(vault.api, vault.core);
    if (vaultSync?.vault.id !== summary.id)
      vaultSync = new VaultSync(vault.api, vault.core, summary);
    await vaultSync.pull();
    return vaultSync;
  };

  const items: HandleItem = async (op) => {
    const v = await openVault();
    switch (op.op) {
      case 'list':
        return {
          items: v.items().map((i) => ({
            id: i.id,
            title: i.summary.title,
            username: i.summary.username,
            url: i.summary.url,
            hasTotp: i.summary.hasTotp,
          })),
        };
      case 'vault':
        return { vaultId: v.vault.id };
      case 'find':
        return { vaultId: v.vault.id, item: v.cipher(v.find(op.item).id) };
      case 'upload':
        if (op.vaultId !== v.vault.id) throw new Error('That vault is no longer open.');
        await v.putSealed(op.item);
        return {};
      case 'delete': {
        const item = v.find(op.item);
        await v.remove(item.id);
        return { message: `Deleted the item “${item.summary.title}”.` };
      }
    }
  };

  const stops = [
    agents.serveResolves(find),
    agents.serveLists(list),
    agents.serveWrites(save),
    agents.serveStructure(describe),
    agents.serveChanges(apply),
    agents.serveItems(items),
  ];
  return () => {
    for (const stop of stops) void stop.then((unlisten) => unlisten());
  };
}

/** The kind an environment named like this usually is. */
function kindFor(name: string): EnvironmentKind {
  const n = name.trim().toLowerCase();
  if (n === 'development' || n === 'dev' || n === 'local') return 'development';
  if (n === 'staging' || n === 'stage' || n === 'qa' || n === 'test') return 'staging';
  if (n === 'production' || n === 'prod' || n === 'live') return 'production';
  return 'custom';
}

/** Makes one change `zv` asked for and says what it did. */
async function applyChange(
  sync: ProjectsSync,
  ready: () => Promise<unknown>,
  change: Change,
): Promise<string> {
  await ready();
  const project = async (slug: string): Promise<Project> => {
    const found = sync.get().projects.find((p) => p.slug === slug);
    if (!found) throw new Error(`There is no project zv://${slug}.`);
    await sync.pull(found.id);
    return sync.get().projects.find((p) => p.id === found.id)!;
  };
  const environment = (p: Project, slug: string): Environment => {
    const found = p.environments.find((e) => e.slug === slug);
    if (!found) throw new Error(`There is no environment zv://${p.slug}/${slug}.`);
    return found;
  };
  const folder = (p: Project, slug: string) => {
    const found = p.folders.find((f) => f.slug === slug);
    if (!found) throw new Error(`zv://${p.slug} has no folder “${slug}”.`);
    return found;
  };

  switch (change.op) {
    case 'createProject': {
      const envs = change.environments.map((name) => ({ name, kind: kindFor(name) }));
      const id = await sync.createProject(change.name, envs, change.slug ?? undefined);
      const p = sync.get().projects.find((x) => x.id === id)!;
      const made = p.environments.map((e) => e.slug).join(', ');
      return `Created project zv://${p.slug}${made ? ` with environments ${made}` : ''}.`;
    }
    case 'updateProject': {
      const p = await project(change.project);
      await sync.updateProject(p.id, {
        ...(change.name !== null && { name: change.name }),
        ...(change.slug !== null && { slug: change.slug }),
      });
      const now = sync.get().projects.find((x) => x.id === p.id)!;
      return `Saved project zv://${now.slug} (“${now.name}”).`;
    }
    case 'deleteProject': {
      const p = await project(change.project);
      await sync.deleteProject(p.id);
      return `Deleted project zv://${p.slug}.`;
    }
    case 'createEnvironment': {
      const p = await project(change.project);
      const from = change.inheritsFrom ? environment(p, change.inheritsFrom).id : null;
      const id = await sync.createEnvironment(p.id, {
        name: change.name,
        ...(change.slug !== null && { slug: change.slug }),
        kind: change.kind ?? kindFor(change.name),
        inheritsFrom: from,
      });
      const env = sync
        .get()
        .projects.find((x) => x.id === p.id)!
        .environments.find((e) => e.id === id)!;
      return `Created environment zv://${p.slug}/${env.slug}.`;
    }
    case 'updateEnvironment': {
      const p = await project(change.project);
      const env = environment(p, change.environment);
      const inheritsFrom = change.noFallback
        ? null
        : change.inheritsFrom
          ? environment(p, change.inheritsFrom).id
          : undefined;
      await sync.updateEnvironment(p.id, env.id, {
        name: change.name ?? env.name,
        slug: change.slug ?? env.slug,
        ...(change.kind !== null && { kind: change.kind }),
        ...(inheritsFrom !== undefined && { inheritsFrom }),
      });
      return `Saved environment zv://${p.slug}/${change.slug ?? env.slug}.`;
    }
    case 'deleteEnvironment': {
      const p = await project(change.project);
      const env = environment(p, change.environment);
      const orphans = sync.secretsOnlyIn(p.id, env.id).length;
      await sync.deleteEnvironment(p.id, env.id);
      return `Deleted environment zv://${p.slug}/${env.slug}${
        orphans ? ` and ${orphans} secret${orphans === 1 ? '' : 's'} that only it held` : ''
      }.`;
    }
    case 'createFolder': {
      const p = await project(change.project);
      const id = await sync.createFolder(p.id, change.name, change.slug ?? undefined);
      const f = sync
        .get()
        .projects.find((x) => x.id === p.id)!
        .folders.find((x) => x.id === id)!;
      return `Created folder “${f.name}” in zv://${p.slug}. Paths inside it look like zv://${p.slug}/<environment>/${f.slug}/<KEY>.`;
    }
    case 'updateFolder': {
      const p = await project(change.project);
      const f = folder(p, change.folder);
      await sync.updateFolder(p.id, f.id, {
        ...(change.name !== null && { name: change.name }),
        ...(change.slug !== null && { slug: change.slug }),
      });
      return `Saved folder ${change.slug ?? f.slug} in zv://${p.slug}.`;
    }
    case 'deleteFolder': {
      const p = await project(change.project);
      const f = folder(p, change.folder);
      await sync.deleteFolder(p.id, f.id);
      return `Deleted folder ${f.slug} in zv://${p.slug}.`;
    }
    case 'deleteSecret': {
      const path = parseSecretPath(change.reference);
      if (!path) throw new Error(`${change.reference} is not a secret path.`);
      const p = await project(path.project);
      const env = environment(p, path.environment);
      const f = path.folder ? folder(p, path.folder) : null;
      const secret: ProjectSecret | undefined = sync
        .get()
        .secrets.find(
          (s) =>
            s.projectId === p.id &&
            s.key === path.key &&
            (s.folder?.id ?? null) === (f?.id ?? null),
        );
      if (!secret) throw new Error(`There is no secret ${change.reference}.`);
      if (change.allEnvironments) {
        await sync.deleteSecret(p.id, secret.id);
        return `Moved ${secret.key} in zv://${p.slug} to Trash. Restore it from the Mac app within 30 days.`;
      }
      if (!secret.values[env.id]) {
        const source = valueSource(p, secret, env.id);
        const from = p.environments.find((e) => e.id === source);
        throw new Error(
          from
            ? `${change.reference} has no value of its own; it falls back to ${from.slug}. Delete it there, or pass --all-environments.`
            : `${change.reference} has no value.`,
        );
      }
      await sync.removeValue(p.id, secret.id, env.id);
      return `Deleted the value of ${change.reference}.`;
    }
  }
}

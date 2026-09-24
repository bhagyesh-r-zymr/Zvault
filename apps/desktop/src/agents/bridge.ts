import { parseSecretPath } from '@zvault/shared';
import { secretRef, valueSource } from '../projects/model.js';
import type { ProjectsSync } from '../projects/sync.js';
import { agents, type FindSecret, type ListSecrets, type SaveSecret } from './api.js';

/**
 * Answers the Rust core's `zv://` lookups from the synced projects, so `zv
 * read`, `run`, `ls`, `env` and `set` work on real secrets. Only ciphertext
 * passes through here: Rust decrypts values for the CLI and seals what
 * `zv set` writes. Each lookup first pulls the project's latest changes.
 *
 * Returns a function that stops answering.
 */
export function serveZv(sync: ProjectsSync): () => void {
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

  const list: ListSecrets = async (prefix) => {
    await ready();
    await Promise.all(sync.get().projects.map((p) => sync.pull(p.id).catch(() => undefined)));
    const { projects, secrets } = sync.get();
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

  const stops = [agents.serveResolves(find), agents.serveLists(list), agents.serveWrites(save)];
  return () => {
    for (const stop of stops) void stop.then((unlisten) => unlisten());
  };
}

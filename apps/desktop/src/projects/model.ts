import {
  formatSecretPath,
  type EncryptedBlob,
  type EnvironmentKind,
  type EnvironmentMeta,
  type FolderMeta,
  type ProjectMeta,
  type SecretMeta,
} from '@zvault/shared';

/**
 * UI model for project secrets: Project › Environment › (one level of)
 * Folder, plus free-form tags. One secret holds a value per environment.
 *
 * Everything here is built from decrypted metadata by {@link toView}; secret
 * values stay sealed (one blob per environment) until the person reveals or
 * copies one.
 */

/** Default dot colour of each environment kind; `EnvironmentMeta.color` overrides it. */
export const ENV_COLORS: Record<EnvironmentKind, string> = {
  development: '#45d6a0',
  staging: '#f2b64c',
  production: '#ff7a7a',
  custom: '#d9a3f5',
};

/** How each environment kind is named in pickers. */
export const ENV_KIND_LABELS: Record<EnvironmentKind, string> = {
  development: 'Development',
  staging: 'Staging',
  production: 'Production',
  custom: 'Custom',
};

/** Project tiles, picked by id so a project keeps its colour. */
const TILES: { bg: string; fg: string }[] = [
  { bg: '#4c5be8', fg: '#fff' },
  { bg: '#1e3b33', fg: '#7fe6be' },
  { bg: '#3a2a14', fg: '#f2b64c' },
  { bg: '#33203a', fg: '#d9a3f5' },
];

export interface Environment {
  id: string;
  revision: number;
  name: string;
  slug: string;
  /** Label for the environment tabs: "Dev", "Prod", "QA". */
  short: string;
  kind: EnvironmentKind;
  color: string;
  position: number;
  inheritsFrom: string | null;
  /** This account holds no key for it, so its values can't be read or written. */
  locked: boolean;
}

export interface Folder {
  id: string;
  revision: number;
  name: string;
  slug: string;
}

export interface Project {
  id: string;
  /** Used in `zv://<slug>/<env>/[<folder>/]<KEY>` references. */
  slug: string;
  name: string;
  description?: string;
  /** Whether this account owns it; owners (and org admins) change environments and folders. */
  owner: boolean;
  tile: { bg: string; fg: string };
  environments: Environment[];
  folders: Folder[];
}

export interface ProjectSecret {
  id: string;
  projectId: string;
  revision: number;
  name: string;
  /** Variable name for `zv run`, also the last segment of its path. */
  key: string;
  folder: Folder | null;
  tags: string[];
  note?: string;
  /** Sealed value per environment id, for environments this account can read. */
  values: Record<string, EncryptedBlob | undefined>;
}

/** Decrypted state of one project, as the sync keeps it. */
export interface ProjectState {
  id: string;
  revision: number;
  owner: boolean;
  meta: ProjectMeta;
  environments: Map<string, { revision: number; meta: EnvironmentMeta; unlocked: boolean }>;
  folders: Map<string, { revision: number; meta: FolderMeta }>;
  secrets: Map<
    string,
    { revision: number; meta: SecretMeta; values: Record<string, EncryptedBlob | undefined> }
  >;
}

export interface ProjectsView {
  projects: Project[];
  secrets: ProjectSecret[];
}

const SHORT: Partial<Record<EnvironmentKind, string>> = { development: 'Dev', production: 'Prod' };

function shortName(name: string, kind: EnvironmentKind): string {
  if (SHORT[kind]) return SHORT[kind];
  return name.length > 8 ? name.split(/\s+/)[0]! : name;
}

function tileFor(id: string, color: string | undefined): { bg: string; fg: string } {
  if (color) return { bg: color, fg: '#fff' };
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length]!;
}

/** Turns decrypted project state into what the screens show. Pure. */
export function toView(states: Iterable<ProjectState>): ProjectsView {
  const projects: Project[] = [];
  const secrets: ProjectSecret[] = [];
  for (const s of states) {
    const environments = [...s.environments]
      .map(([id, e]): Environment => ({
        id,
        revision: e.revision,
        name: e.meta.name,
        slug: e.meta.slug,
        short: shortName(e.meta.name, e.meta.kind),
        kind: e.meta.kind,
        color: e.meta.color ?? ENV_COLORS[e.meta.kind],
        position: e.meta.position,
        inheritsFrom: e.meta.inheritsFrom,
        locked: !e.unlocked,
      }))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const folders = [...s.folders]
      .map(([id, f]): Folder => ({
        id,
        revision: f.revision,
        name: f.meta.name,
        slug: f.meta.slug,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    projects.push({
      id: s.id,
      slug: s.meta.slug,
      name: s.meta.name,
      ...(s.meta.description && { description: s.meta.description }),
      owner: s.owner,
      tile: tileFor(s.id, s.meta.color),
      environments,
      folders,
    });
    for (const [id, sec] of s.secrets) {
      secrets.push({
        id,
        projectId: s.id,
        revision: sec.revision,
        name: sec.meta.name,
        key: sec.meta.key,
        folder: folders.find((f) => f.id === sec.meta.folderId) ?? null,
        tags: sec.meta.tags,
        ...(sec.meta.note && { note: sec.meta.note }),
        values: sec.values,
      });
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  secrets.sort((a, b) => a.name.localeCompare(b.name));
  return { projects, secrets };
}

/**
 * The environment whose value applies to `envId`: its own, or the one it
 * inherits from ("Same as Development"), following the chain. `null` if unset.
 */
export function valueSource(project: Project, secret: ProjectSecret, envId: string): string | null {
  const seen = new Set<string>();
  let id: string | null = envId;
  while (id && !seen.has(id)) {
    if (secret.values[id]) return id;
    seen.add(id);
    id = project.environments.find((e) => e.id === id)?.inheritsFrom ?? null;
  }
  return null;
}

/** The `zv run` reference of a secret in one environment. */
export function secretRef(project: Project, env: Environment, secret: ProjectSecret): string {
  return formatSecretPath({
    project: project.slug,
    environment: env.slug,
    folder: secret.folder?.slug ?? null,
    key: secret.key,
  });
}

/** `base`, or `base-2`, `base-3`… whichever is not taken yet. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(slug)) return slug;
  }
}

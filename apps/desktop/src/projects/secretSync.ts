import { invoke } from '@tauri-apps/api/core';
import type { EncryptedBlob, SyncTarget } from '@zvault/shared';
import { valueSource, type Environment, type Project, type ProjectsView } from './model.js';
import type { ProjectsSync } from './sync.js';

/**
 * Secret sync: pushing an environment's secrets to GitHub Actions or AWS
 * Secrets Manager from this Mac.
 *
 * Targets live in the environment's encrypted metadata, so every member and
 * device sees them. Credentials and values never pass through here: the UI
 * hands Rust the ciphertext the project sync already holds, and Rust
 * decrypts each value, signs in with the credential from the keychain and
 * pushes. What comes back is names and counts.
 *
 * An environment syncs when it changes (on any device) and on "Sync now".
 * Each target's last result is remembered on this Mac only.
 */

export type Provider = SyncTarget['provider'];

export const PROVIDER_NAMES: Record<Provider, string> = { github: 'GitHub', aws: 'AWS' };

export type Credential =
  | { provider: 'github'; token: string }
  | {
      provider: 'aws';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };

/** Who this Mac's credentials belong to, per provider; `null` when not connected. */
export type Connections = Record<Provider, string | null>;

export interface SyncItem {
  name: string;
  secretId: string;
  /** Where the value is sealed: the target environment, or the one it falls back to. */
  environmentId: string;
  encryptedValue: EncryptedBlob;
}

export interface SyncReport {
  pushed: string[];
  removed: string[];
  failed: { name: string; reason: string }[];
}

export interface SyncCore {
  connections(): Promise<Connections>;
  /** Checks the credential with the provider, keeps it in the keychain, returns who it is. */
  connect(credential: Credential): Promise<string>;
  disconnect(provider: Provider): Promise<void>;
  push(
    projectId: string,
    target: SyncTarget,
    items: SyncItem[],
    previous: string[],
  ): Promise<SyncReport>;
}

export const syncCore: SyncCore = {
  connections: () => invoke('sync_connections'),
  connect: (credential) => invoke('sync_connect', { credential }),
  disconnect: (provider) => invoke('sync_disconnect', { provider }),
  push: (projectId, target, items, previous) =>
    invoke('sync_push', { projectId, target, items, previous }),
};

/** A target's last sync on this Mac. */
export interface TargetStatus {
  state: 'syncing' | 'synced' | 'partial' | 'failed';
  /** When the last attempt finished (or started, while syncing). */
  at: string;
  /** What happened, in a sentence. */
  message: string;
  /** The environment's contents as last attempted, to tell when it changed. */
  fingerprint: string;
  /** Names the last successful push wrote, so later pushes can remove stale ones. */
  names: string[];
  /** Set when it failed for want of this provider's credentials on this Mac. */
  needs?: Provider;
}

export interface SecretSyncSnapshot {
  connections: Connections | null;
  status: Record<string, TargetStatus>;
}

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'zvault.secretSync.v1';
/** Changes made in quick succession go out as one push. */
const SETTLE_MS = 2_000;

/** The variables an environment exports, with inherited values resolved. */
export function itemsFor(view: ProjectsView, project: Project, env: Environment): SyncItem[] {
  const items: SyncItem[] = [];
  for (const secret of view.secrets) {
    if (secret.projectId !== project.id) continue;
    const source = valueSource(project, secret, env.id);
    const encryptedValue = source ? secret.values[source] : undefined;
    if (!source || !encryptedValue) continue;
    items.push({ name: secret.key, secretId: secret.id, environmentId: source, encryptedValue });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Changes whenever a value, name or the target itself changes. Not a secret. */
export function fingerprint(target: SyncTarget, items: SyncItem[]): string {
  const text = JSON.stringify([
    target,
    items.map((i) => [i.name, i.secretId, i.environmentId, i.encryptedValue.nonce]),
  ]);
  // FNV-1a, twice with different seeds: only compared, never trusted.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Where a target pushes to, for a row or a log line. */
export function describeTarget(target: SyncTarget): string {
  return target.provider === 'github'
    ? target.environment
      ? `${target.repo} · ${target.environment} environment`
      : target.repo
    : `${target.secretName} · ${target.region}`;
}

function summarize(report: SyncReport): { state: TargetStatus['state']; message: string } {
  const n = report.pushed.length;
  const parts = [n === 1 ? '1 secret pushed' : `${n} secrets pushed`];
  if (report.removed.length) parts.push(`${report.removed.length} removed`);
  if (report.failed.length === 0) return { state: 'synced', message: parts.join(', ') };
  const first = report.failed[0]!;
  parts.push(
    `${report.failed.length} not synced (${first.name}: ${first.reason}${report.failed.length > 1 ? ', …' : ''})`,
  );
  return { state: 'partial', message: parts.join(', ') };
}

function errorText(e: unknown): string {
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  if (!text) return 'The sync failed.';
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/\.?$/, '.');
}

/** Pushes environments to their targets when they change, and on request. */
export class SecretSyncer {
  private snapshot: SecretSyncSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly running = new Map<string, Promise<TargetStatus>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private loadingConnections: Promise<Connections> | null = null;

  constructor(
    private readonly projects: ProjectsSync,
    private readonly core: SyncCore = syncCore,
    private readonly storage: Storage | null = globalThis.localStorage ?? null,
    private readonly now: () => Date = () => new Date(),
  ) {
    let status: Record<string, TargetStatus> = {};
    try {
      status = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? '{}') as typeof status;
    } catch {
      // A damaged record only loses the history.
    }
    // A sync cut short by a quit is not still running.
    for (const [id, s] of Object.entries(status)) {
      if (s.state === 'syncing') status[id] = { ...s, state: 'failed', message: 'Interrupted.' };
    }
    this.snapshot = { connections: null, status };
  }

  get = (): SecretSyncSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Starts syncing environments as they change. Returns a function that stops it. */
  start(): () => void {
    this.unsubscribe = this.projects.subscribe(() => this.schedule());
    this.schedule();
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** Reads which providers this Mac is connected to (once, unless `refresh`). */
  async connections(refresh = false): Promise<Connections> {
    if (this.snapshot.connections && !refresh) return this.snapshot.connections;
    this.loadingConnections ??= this.core
      .connections()
      .then((c) => {
        this.set({ connections: c });
        return c;
      })
      .finally(() => {
        this.loadingConnections = null;
      });
    return this.loadingConnections;
  }

  async connect(credential: Credential): Promise<string> {
    const who = await this.core.connect(credential);
    await this.connections(true);
    this.schedule();
    return who;
  }

  async disconnect(provider: Provider): Promise<void> {
    await this.core.disconnect(provider);
    await this.connections(true);
  }

  /** Pushes one target now, whether or not anything changed. */
  syncTarget(projectId: string, envId: string, targetId: string): Promise<TargetStatus> {
    const running = this.running.get(targetId);
    if (running) return running;
    const task = this.push(projectId, envId, targetId).finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    return task;
  }

  /** Pushes every target of an environment now. */
  async syncEnvironment(projectId: string, envId: string): Promise<TargetStatus[]> {
    const env = this.find(projectId, envId)?.env;
    if (!env) throw new Error('This environment is no longer available.');
    if (env.sync.length === 0) throw new Error('This environment has nowhere to sync to yet.');
    return Promise.all(env.sync.map((t) => this.syncTarget(projectId, envId, t.id)));
  }

  private find(projectId: string, envId: string) {
    const view = this.projects.get();
    const project = view.projects.find((p) => p.id === projectId);
    const env = project?.environments.find((e) => e.id === envId);
    return project && env ? { view, project, env } : null;
  }

  private async push(projectId: string, envId: string, targetId: string): Promise<TargetStatus> {
    const found = this.find(projectId, envId);
    const target = found?.env.sync.find((t) => t.id === targetId);
    if (!found || !target) throw new Error('This sync target is no longer available.');
    const { view, project, env } = found;
    const previous = this.snapshot.status[targetId];
    const items = itemsFor(view, project, env);
    const print = fingerprint(target, items);
    const finish = (status: Omit<TargetStatus, 'at' | 'fingerprint'>) => {
      const done = { ...status, at: this.now().toISOString(), fingerprint: print };
      this.setStatus(targetId, done);
      return done;
    };
    if (env.locked) {
      return finish({
        state: 'failed',
        message: 'This account has no access to the environment’s values.',
        names: previous?.names ?? [],
      });
    }
    const connections = await this.connections().catch(() => null);
    if (connections && !connections[target.provider]) {
      return finish({
        state: 'failed',
        message: `Connect ${PROVIDER_NAMES[target.provider]} on this Mac to sync.`,
        names: previous?.names ?? [],
        needs: target.provider,
      });
    }
    this.setStatus(targetId, {
      state: 'syncing',
      at: this.now().toISOString(),
      message: 'Syncing…',
      fingerprint: previous?.fingerprint ?? '',
      names: previous?.names ?? [],
    });
    try {
      const report = await this.core.push(project.id, target, items, previous?.names ?? []);
      const failed = new Set(report.failed.map((f) => f.name));
      return finish({
        ...summarize(report),
        // Keep failed names so a later push still removes them if they go.
        names: [...report.pushed, ...(previous?.names ?? []).filter((n) => failed.has(n))],
      });
    } catch (e) {
      return finish({ state: 'failed', message: errorText(e), names: previous?.names ?? [] });
    }
  }

  /** Looks for environments whose contents changed since their last push. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncChanged();
    }, SETTLE_MS);
  }

  private async syncChanged(): Promise<void> {
    const view = this.projects.get();
    if (view.status !== 'ready') return;
    const due: [string, string, string][] = [];
    for (const project of view.projects) {
      for (const env of project.environments) {
        if (env.locked) continue;
        const items = env.sync.length ? itemsFor(view, project, env) : [];
        for (const target of env.sync) {
          if (target.auto === false || this.running.has(target.id)) continue;
          const last = this.snapshot.status[target.id];
          // A failed attempt is retried when something changes or on Sync now.
          if (last?.fingerprint !== fingerprint(target, items)) {
            due.push([project.id, env.id, target.id]);
          }
        }
      }
    }
    const connections = await this.connections().catch(() => null);
    if (!connections) return;
    // Waiting on credentials that this Mac now has.
    for (const project of view.projects) {
      for (const env of project.environments) {
        for (const target of env.sync) {
          const needs = this.snapshot.status[target.id]?.needs;
          if (needs && connections[needs] && !due.some(([, , t]) => t === target.id)) {
            due.push([project.id, env.id, target.id]);
          }
        }
      }
    }
    await Promise.all(due.map(([p, e, t]) => this.syncTarget(p, e, t).catch(() => undefined)));
  }

  private setStatus(targetId: string, status: TargetStatus): void {
    const all = { ...this.snapshot.status, [targetId]: status };
    this.set({ status: all });
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Private mode or a full disk: status just won't survive a restart.
    }
  }

  private set(patch: Partial<SecretSyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}

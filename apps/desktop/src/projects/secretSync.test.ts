import type { EncryptedBlob, SyncTarget } from '@zvault/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, Project, ProjectSecret } from './model.js';
import {
  fingerprint,
  itemsFor,
  SecretSyncer,
  type Connections,
  type Credential,
  type SyncItem,
  type SyncCore,
  type SyncReport,
} from './secretSync.js';
import type { ProjectsSnapshot, ProjectsSync } from './sync.js';

const blob = (nonce: string) =>
  ({ v: 1, alg: 'xchacha20poly1305', kid: 'env', nonce, ct: 'x' }) as unknown as EncryptedBlob;

const GH: SyncTarget = { provider: 'github', id: 'gh1', repo: 'acme/web' };
const AWS: SyncTarget = {
  provider: 'aws',
  id: 'aws1',
  region: 'ap-south-1',
  secretName: 'web/prod',
};

function env(id: string, over: Partial<Environment> = {}): Environment {
  return {
    id,
    revision: 1,
    name: id,
    slug: id,
    short: id,
    kind: 'custom',
    color: '',
    position: 0,
    inheritsFrom: null,
    locked: false,
    sync: [],
    ...over,
  };
}

function secret(id: string, key: string, values: Record<string, EncryptedBlob>): ProjectSecret {
  return { id, projectId: 'p1', revision: 1, name: key, key, folder: null, tags: [], values };
}

class FakeProjects {
  snapshot: ProjectsSnapshot;
  private listeners = new Set<() => void>();
  constructor(project: Project, secrets: ProjectSecret[]) {
    this.snapshot = { projects: [project], secrets, status: 'ready', error: null, unreadable: 0 };
  }
  get = () => this.snapshot;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  change(secrets: ProjectSecret[]) {
    this.snapshot = { ...this.snapshot, secrets };
    for (const l of this.listeners) l();
  }
}

function fakeCore(connections: Connections) {
  const pushes: { target: SyncTarget; names: string[]; previous: string[] }[] = [];
  const core: SyncCore = {
    connections: () => Promise.resolve({ ...connections }),
    connect: (c: Credential) => {
      connections[c.provider] = 'octocat';
      return Promise.resolve('octocat');
    },
    disconnect: () => Promise.resolve(),
    push: (_p: string, target: SyncTarget, items: SyncItem[], previous: string[]) => {
      pushes.push({ target, names: items.map((i) => i.name), previous });
      return Promise.resolve<SyncReport>({
        pushed: items.map((i) => i.name),
        removed: [],
        failed: [],
      });
    },
  };
  return { core, pushes };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
  };
}

const dev = env('dev');
const prod = env('prod', { inheritsFrom: 'dev', sync: [GH, AWS] });
const project: Project = {
  id: 'p1',
  slug: 'web',
  name: 'Web',
  owner: true,
  tile: { bg: '', fg: '' },
  environments: [dev, prod],
  folders: [],
};
const secrets = [
  secret('s1', 'DATABASE_URL', { dev: blob('a'), prod: blob('b') }),
  secret('s2', 'LOG_LEVEL', { dev: blob('c') }),
  secret('s3', 'DEV_ONLY', {}),
];

describe('itemsFor', () => {
  it('uses the environment’s own values and falls back like zv run', () => {
    const view = { projects: [project], secrets };
    expect(itemsFor(view, project, prod).map((i) => [i.name, i.environmentId])).toEqual([
      ['DATABASE_URL', 'prod'],
      ['LOG_LEVEL', 'dev'],
    ]);
  });

  it('fingerprints change with a value but not otherwise', () => {
    const view = { projects: [project], secrets };
    const a = fingerprint(GH, itemsFor(view, project, prod));
    expect(fingerprint(GH, itemsFor(view, project, prod))).toBe(a);
    const changed = [
      secret('s1', 'DATABASE_URL', { dev: blob('a'), prod: blob('z') }),
      ...secrets.slice(1),
    ];
    expect(
      fingerprint(GH, itemsFor({ projects: [project], secrets: changed }, project, prod)),
    ).not.toBe(a);
    expect(fingerprint(AWS, itemsFor(view, project, prod))).not.toBe(a);
  });
});

describe('SecretSyncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes each target on Sync now and remembers what it wrote', async () => {
    const projects = new FakeProjects(project, secrets);
    const { core, pushes } = fakeCore({ github: 'octocat', aws: 'arn:aws:iam::1:user/ci' });
    const storage = memoryStorage();
    const syncer = new SecretSyncer(projects as unknown as ProjectsSync, core, storage);

    const results = await syncer.syncEnvironment('p1', 'prod');
    expect(results.map((r) => r.state)).toEqual(['synced', 'synced']);
    expect(pushes.map((p) => p.target.provider)).toEqual(['github', 'aws']);
    expect(syncer.get().status.gh1?.names).toEqual(['DATABASE_URL', 'LOG_LEVEL']);
    expect(syncer.get().status.gh1?.message).toBe('2 secrets pushed');

    // The next push hands GitHub the names written last time.
    await syncer.syncTarget('p1', 'prod', 'gh1');
    expect(pushes[2]!.previous).toEqual(['DATABASE_URL', 'LOG_LEVEL']);

    // Status survives a restart.
    const again = new SecretSyncer(projects as unknown as ProjectsSync, core, storage);
    expect(again.get().status.aws1?.state).toBe('synced');
  });

  it('syncs on its own when a value changes, and only then', async () => {
    const projects = new FakeProjects(project, secrets);
    const { core, pushes } = fakeCore({ github: 'octocat', aws: 'arn' });
    const syncer = new SecretSyncer(projects as unknown as ProjectsSync, core, memoryStorage());
    const stop = syncer.start();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(pushes).toHaveLength(2);

    projects.change([...secrets]); // same contents
    await vi.advanceTimersByTimeAsync(2_500);
    expect(pushes).toHaveLength(2);

    projects.change([
      secret('s1', 'DATABASE_URL', { dev: blob('a'), prod: blob('new') }),
      ...secrets.slice(1),
    ]);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(pushes).toHaveLength(4);
    stop();
  });

  it('waits for credentials and syncs once this Mac connects', async () => {
    const onlyGh = {
      ...project,
      environments: [dev, env('prod', { inheritsFrom: 'dev', sync: [GH] })],
    };
    const projects = new FakeProjects(onlyGh, secrets);
    const { core, pushes } = fakeCore({ github: null, aws: null });
    const syncer = new SecretSyncer(projects as unknown as ProjectsSync, core, memoryStorage());
    const stop = syncer.start();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(pushes).toHaveLength(0);
    expect(syncer.get().status.gh1).toMatchObject({ state: 'failed', needs: 'github' });

    await syncer.connect({ provider: 'github', token: 't' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(pushes).toHaveLength(1);
    expect(syncer.get().status.gh1?.state).toBe('synced');
    stop();
  });

  it('reports a failed push without throwing', async () => {
    const projects = new FakeProjects(project, secrets);
    const { core } = fakeCore({ github: 'octocat', aws: 'arn' });
    core.push = () =>
      Promise.reject(
        new Error('GitHub refused the credentials (401); connect it again with a new one'),
      );
    const syncer = new SecretSyncer(projects as unknown as ProjectsSync, core, memoryStorage());
    const r = await syncer.syncTarget('p1', 'prod', 'gh1');
    expect(r.state).toBe('failed');
    expect(r.message).toBe(
      'GitHub refused the credentials (401); connect it again with a new one.',
    );
  });
});

/* eslint-disable @typescript-eslint/require-await -- test doubles */
import { emit } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, Project, ProjectSecret } from '../projects/model.js';
import type { SecretSyncer } from '../projects/secretSync.js';
import type { ProjectsSync } from '../projects/sync.js';
import { mockCore } from '../test/tauri.js';
import type { VaultApi } from '../vault/api.js';
import type { VaultCore } from '../vault/core.js';
import type { Change } from './api.js';
import { serveZv } from './bridge.js';

const mocks = vi.hoisted(() => ({
  openDefaultVault: vi.fn(),
  VaultSync: vi.fn(),
}));
vi.mock('../vault/sync.js', () => ({
  openDefaultVault: mocks.openDefaultVault,
  VaultSync: mocks.VaultSync,
}));

const blob = (n: string) =>
  ({ v: 1, alg: 'xchacha20poly1305', kid: 'k', nonce: n, ct: 'c' }) as never;

function env(over: Partial<Environment> & { id: string; slug: string }): Environment {
  return {
    revision: 1,
    name: over.slug,
    short: over.slug,
    kind: 'development',
    color: 'x',
    position: 0,
    inheritsFrom: null,
    locked: false,
    sync: [],
    ...over,
  };
}

let state: { projects: Project[]; secrets: ProjectSecret[]; status: string };
let replies: Record<string, unknown>;
let n = 0;

function makeState() {
  const web: Project = {
    id: 'p1',
    slug: 'web',
    name: 'Web',
    owner: true,
    tile: { bg: 'a', fg: 'b' },
    environments: [
      env({ id: 'e1', slug: 'development' }),
      env({ id: 'e2', slug: 'production', kind: 'production', inheritsFrom: 'e1' }),
      env({ id: 'e3', slug: 'secret', locked: true }),
    ],
    folders: [{ id: 'f1', revision: 1, name: 'CI', slug: 'ci' }],
  };
  const secret = (id: string, key: string, folder: boolean, values: ProjectSecret['values']) =>
    ({
      id,
      projectId: 'p1',
      revision: 1,
      name: key,
      key,
      folder: folder ? web.folders[0]! : null,
      tags: [],
      values,
    }) as ProjectSecret;
  state = {
    status: 'idle',
    projects: [web],
    secrets: [
      secret('s1', 'API_KEY', false, { e1: blob('1') }),
      secret('s2', 'CI_KEY', true, { e1: blob('2'), e2: blob('3') }),
    ],
  };
}

function makeSync() {
  const sync = {
    get: () => state,
    load: vi.fn(async () => {
      state.status = 'ready';
    }),
    pull: vi.fn(async () => undefined),
    putSealedValue: vi.fn(async () => undefined),
    createProject: vi.fn(async (name: string, _envs: unknown, slug?: string) => {
      state.projects.push({
        id: 'p2',
        slug: slug ?? 'new',
        name,
        owner: true,
        tile: { bg: 'a', fg: 'b' },
        environments: [env({ id: 'n1', slug: 'dev' })],
        folders: [],
      });
      return 'p2';
    }),
    updateProject: vi.fn(async (id: string, ch: { name?: string; slug?: string }) => {
      const p = state.projects.find((x) => x.id === id)!;
      Object.assign(p, ch);
    }),
    deleteProject: vi.fn(async () => undefined),
    createEnvironment: vi.fn(async (pid: string, draft: { name: string; slug?: string }) => {
      state.projects
        .find((p) => p.id === pid)!
        .environments.push(env({ id: `e9${++n}`, slug: draft.slug ?? 'staging' }));
      return `e9${n}`;
    }),
    updateEnvironment: vi.fn(async () => undefined),
    deleteEnvironment: vi.fn(async () => undefined),
    secretsOnlyIn: vi.fn(() => ['s1'] as string[]),
    createFolder: vi.fn(async (pid: string, name: string, slug?: string) => {
      state.projects
        .find((p) => p.id === pid)!
        .folders.push({ id: 'f9', revision: 1, name, slug: slug ?? 'infra' });
      return 'f9';
    }),
    updateFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    removeValue: vi.fn(async () => undefined),
  };
  return sync;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function ask<T = unknown>(event: string, payload: Record<string, unknown>): Promise<T> {
  const requestId = `r${++n}`;
  await emit(event, { requestId, ...payload });
  await vi.waitFor(() => expect(requestId in replies).toBe(true));
  return replies[requestId] as T;
}

let stop: (() => void) | undefined;
let sync: ReturnType<typeof makeSync>;
let syncer: { syncEnvironment: ReturnType<typeof vi.fn> };

async function start(vault = false) {
  sync = makeSync();
  syncer = { syncEnvironment: vi.fn() };
  stop = serveZv(
    sync as unknown as ProjectsSync,
    vault ? { api: {} as VaultApi, core: {} as VaultCore } : undefined,
    syncer as unknown as SecretSyncer,
  );
  await tick();
}

beforeEach(() => {
  makeState();
  replies = {};
  mocks.openDefaultVault.mockReset();
  mocks.VaultSync.mockReset();
  const store = (args: Record<string, unknown>) => {
    replies[args.requestId as string] = args;
  };
  mockCore({
    agent_resolve_respond: store,
    agent_list_respond: store,
    agent_write_respond: store,
    agent_ui_respond: (a: Record<string, unknown>) => {
      replies[a.requestId as string] = a.reply;
    },
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('serveZv resolve', () => {
  it('resolves paths to ids and sealed values', async () => {
    await start();
    const out = await ask<{ items: Record<string, unknown>[] }>('agent://resolve-request', {
      refs: [
        'zv://web/development/API_KEY',
        'zv://web/production/CI_KEY', // wrong folder: not found as folderless
        'zv://web/production/ci/CI_KEY',
        'zv://web/development/NEW_KEY',
        'zv://web/secret/API_KEY',
        'zv://nope/development/API_KEY',
        'zv://web/development/missing/API_KEY',
        'not a path',
      ],
    });
    const byRef: Record<string, Record<string, unknown> | undefined> = Object.fromEntries(
      out.items.map((i) => [i.reference as string, i]),
    );
    expect(byRef['zv://web/development/API_KEY']).toMatchObject({
      projectId: 'p1',
      environmentId: 'e1',
      secretId: 's1',
      folderId: null,
      valueEnvironmentId: 'e1',
    });
    expect(byRef['zv://web/production/ci/CI_KEY']).toMatchObject({
      secretId: 's2',
      folderId: 'f1',
      valueEnvironmentId: 'e2',
    });
    // A key that does not exist yet resolves with a null secret (zv set creates it).
    expect(byRef['zv://web/development/NEW_KEY']).toMatchObject({
      secretId: null,
      encryptedValue: null,
    });
    expect(byRef['zv://web/secret/API_KEY']).toBeUndefined();
    expect(byRef['zv://nope/development/API_KEY']).toBeUndefined();
    expect(byRef['zv://web/development/missing/API_KEY']).toBeUndefined();
    expect(byRef['not a path']).toBeUndefined();
    expect(sync.load).toHaveBeenCalledTimes(1);
    expect(sync.pull).toHaveBeenCalledWith('p1');
  });

  it('skips a ref whose lookup throws', async () => {
    await start();
    sync.pull.mockRejectedValueOnce(new Error('offline'));
    const out = await ask<{ items: unknown[] }>('agent://resolve-request', {
      refs: ['zv://web/development/API_KEY'],
    });
    expect(out.items).toEqual([]);
  });
});

describe('serveZv list and structure', () => {
  it('lists secret paths with values under a prefix', async () => {
    await start();
    const all = await ask<{ refs: string[] }>('agent://list-request', { prefix: null });
    expect(all.refs).toContain('zv://web/development/API_KEY');
    expect(all.refs).toContain('zv://web/production/API_KEY'); // inherited
    expect(all.refs.some((r) => r.includes('/secret/'))).toBe(false); // locked
    const some = await ask<{ refs: string[] }>('agent://list-request', {
      prefix: 'zv://web/production/*',
    });
    expect(some.refs.every((r) => r.startsWith('zv://web/production/'))).toBe(true);
    expect(some.refs.length).toBeGreaterThan(0);
  });

  it('survives a failing pull when listing', async () => {
    await start();
    sync.pull.mockRejectedValue(new Error('x'));
    const out = await ask<{ refs: string[] }>('agent://list-request', { prefix: null });
    expect(out.refs.length).toBeGreaterThan(0);
  });

  it('describes projects by name', async () => {
    await start();
    const out = await ask<
      { slug: string; environments: { slug: string; inheritsFrom: string | null }[] }[]
    >('agent://structure-request', {});
    expect(out[0]!.slug).toBe('web');
    expect(out[0]!.environments.find((e) => e.slug === 'production')!.inheritsFrom).toBe(
      'development',
    );
  });
});

describe('serveZv writes', () => {
  const write = {
    reference: 'zv://web/development/API_KEY',
    projectId: 'p1',
    environmentId: 'e1',
    secretId: 's1',
    encryptedValue: blob('9'),
    encryptedMeta: null,
    created: false,
  };

  it('saves sealed values and reports success', async () => {
    await start();
    const out = await ask<{ error: string | null }>('agent://write-request', write);
    expect(out.error).toBeNull();
    expect(sync.putSealedValue).toHaveBeenCalledWith(expect.objectContaining({ secretId: 's1' }));
  });

  it('reports failures to the CLI', async () => {
    await start();
    sync.putSealedValue.mockRejectedValueOnce(new Error('conflict'));
    expect((await ask<{ error: string }>('agent://write-request', write)).error).toBe('conflict');
    sync.putSealedValue.mockRejectedValueOnce('plain');
    expect((await ask<{ error: string }>('agent://write-request', write)).error).toBe('plain');
  });
});

describe('serveZv changes', () => {
  const change = (c: Change) =>
    ask<{ message?: string; error?: string }>('agent://change-request', { change: c });
  const blank = {
    name: null,
    slug: null,
    kind: null,
    inheritsFrom: null,
  };

  it('creates, updates and deletes projects', async () => {
    await start();
    const made = await change({
      op: 'createProject',
      name: 'Pay',
      slug: null,
      environments: ['Dev', 'Staging', 'Prod', 'Weird'],
    });
    expect(made.message).toBe('Created project zv://new with environments dev.');
    expect(sync.createProject).toHaveBeenCalledWith(
      'Pay',
      [
        { name: 'Dev', kind: 'development' },
        { name: 'Staging', kind: 'staging' },
        { name: 'Prod', kind: 'production' },
        { name: 'Weird', kind: 'custom' },
      ],
      undefined,
    );
    expect(
      (await change({ op: 'updateProject', project: 'web', name: 'Site', slug: 'site' })).message,
    ).toBe('Saved project zv://site (“Site”).');
    expect(
      (await change({ op: 'updateProject', project: 'site', name: null, slug: null })).message,
    ).toContain('Saved project');
    expect((await change({ op: 'deleteProject', project: 'site' })).message).toBe(
      'Deleted project zv://site.',
    );
    expect((await change({ op: 'deleteProject', project: 'ghost' })).error).toBe(
      'There is no project zv://ghost.',
    );
  });

  it('creates, edits and deletes environments', async () => {
    await start();
    expect(
      (
        await change({
          op: 'createEnvironment',
          project: 'web',
          name: 'QA',
          slug: 'qa',
          kind: null,
          inheritsFrom: 'development',
        })
      ).message,
    ).toBe('Created environment zv://web/qa.');
    expect(sync.createEnvironment).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ kind: 'staging', inheritsFrom: 'e1', slug: 'qa' }),
    );
    expect(
      (
        await change({
          op: 'createEnvironment',
          project: 'web',
          ...blank,
          name: 'Staging',
        })
      ).message,
    ).toContain('zv://web/staging');
    expect(
      (
        await change({
          op: 'createEnvironment',
          project: 'web',
          ...blank,
          name: 'X',
          inheritsFrom: 'nope',
        })
      ).error,
    ).toBe('There is no environment zv://web/nope.');

    const upd = await change({
      op: 'updateEnvironment',
      project: 'web',
      environment: 'production',
      ...blank,
      kind: 'production',
      inheritsFrom: 'development',
      noFallback: false,
    });
    expect(upd.message).toBe('Saved environment zv://web/production.');
    expect(sync.updateEnvironment).toHaveBeenLastCalledWith(
      'p1',
      'e2',
      expect.objectContaining({ inheritsFrom: 'e1', kind: 'production' }),
    );
    await change({
      op: 'updateEnvironment',
      project: 'web',
      environment: 'production',
      ...blank,
      slug: 'prod',
      noFallback: true,
    });
    expect(sync.updateEnvironment).toHaveBeenLastCalledWith(
      'p1',
      'e2',
      expect.objectContaining({ inheritsFrom: null, slug: 'prod' }),
    );
    await change({
      op: 'updateEnvironment',
      project: 'web',
      environment: 'production',
      ...blank,
      noFallback: false,
    });
    expect(sync.updateEnvironment).toHaveBeenLastCalledWith(
      'p1',
      'e2',
      expect.not.objectContaining({ inheritsFrom: expect.anything() as unknown }),
    );

    expect(
      (await change({ op: 'deleteEnvironment', project: 'web', environment: 'production' }))
        .message,
    ).toBe('Deleted environment zv://web/production and 1 secret that only it held.');
    sync.secretsOnlyIn.mockReturnValueOnce(['a', 'b']);
    expect(
      (await change({ op: 'deleteEnvironment', project: 'web', environment: 'production' }))
        .message,
    ).toContain('2 secrets');
    sync.secretsOnlyIn.mockReturnValueOnce([]);
    expect(
      (await change({ op: 'deleteEnvironment', project: 'web', environment: 'production' }))
        .message,
    ).toBe('Deleted environment zv://web/production.');
  });

  it('creates, edits and deletes folders', async () => {
    await start();
    expect(
      (await change({ op: 'createFolder', project: 'web', name: 'Infra', slug: null })).message,
    ).toContain('Created folder “Infra” in zv://web.');
    expect(
      (await change({ op: 'updateFolder', project: 'web', folder: 'ci', name: 'C', slug: 'cx' }))
        .message,
    ).toBe('Saved folder cx in zv://web.');
    expect(
      (await change({ op: 'updateFolder', project: 'web', folder: 'ci', name: null, slug: null }))
        .message,
    ).toBe('Saved folder ci in zv://web.');
    expect((await change({ op: 'deleteFolder', project: 'web', folder: 'ci' })).message).toBe(
      'Deleted folder ci in zv://web.',
    );
    expect((await change({ op: 'deleteFolder', project: 'web', folder: 'zz' })).error).toBe(
      'zv://web has no folder “zz”.',
    );
  });

  it('deletes secrets and explains refusals', async () => {
    await start();
    const del = (reference: string, allEnvironments = false) =>
      change({ op: 'deleteSecret', reference, allEnvironments });
    expect((await del('zv://web/development/API_KEY')).message).toBe(
      'Deleted the value of zv://web/development/API_KEY.',
    );
    expect(sync.removeValue).toHaveBeenCalledWith('p1', 's1', 'e1');
    expect((await del('zv://web/development/API_KEY', true)).message).toContain('to Trash');
    expect((await del('zv://web/development/ci/CI_KEY')).message).toContain('Deleted the value');
    expect((await del('zv://web/development/NOPE')).error).toBe(
      'There is no secret zv://web/development/NOPE.',
    );
    expect((await del('zv://web/production/API_KEY')).error).toContain('falls back to development');
    expect((await del('zv://web/secret/API_KEY')).error).toContain('has no value.');
    expect((await del('bogus')).error).toBe('bogus is not a secret path.');
  });

  it('syncs environments through the syncer', async () => {
    await start();
    const target = { provider: 'github', id: 't1', repo: 'a/b' };
    const aws = { provider: 'aws', id: 't2', secretName: 'sec', region: 'eu-west-1' };
    state.projects[0]!.environments[0]!.sync = [target, aws] as never;
    syncer.syncEnvironment.mockResolvedValueOnce([
      { state: 'synced', message: 'ok' },
      { state: 'partial', message: 'meh' },
    ]);
    const ok = await change({ op: 'syncEnvironment', project: 'web', environment: 'development' });
    expect(ok.message).toBe('GitHub a/b: synced. ok\nAWS sec · eu-west-1: partly synced. meh');
    syncer.syncEnvironment.mockResolvedValueOnce([
      { state: 'failed', message: 'x' },
      { state: 'failed', message: 'y' },
    ]);
    const bad = await change({ op: 'syncEnvironment', project: 'web', environment: 'development' });
    expect(bad.error).toContain('failed. x');
    const none = await change({ op: 'syncEnvironment', project: 'web', environment: 'production' });
    expect(none.error).toContain('nowhere to sync');
  });

  it('refuses to sync without a syncer', async () => {
    sync = makeSync();
    stop = serveZv(sync as unknown as ProjectsSync);
    await tick();
    const out = await ask<{ error: string }>('agent://change-request', {
      change: { op: 'syncEnvironment', project: 'web', environment: 'development' },
    });
    expect(out.error).toBe('Secret sync is not available in this window.');
  });
});

describe('serveZv items', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'i1',
    revision: 1,
    summary: {
      title: 'GitHub',
      username: 'me',
      url: 'https://github.com',
      urls: ['https://github.com'],
      hasTotp: true,
      hasPasskey: false,
      hasSshKey: false,
      ...over,
    },
  });

  function fakeVault() {
    const v = {
      vault: { id: 'v1' },
      pull: vi.fn(async () => undefined),
      items: vi.fn(() => [item(), item({ hasSshKey: true })]),
      cipher: vi.fn((id: string) => ({ cipherFor: id })),
      find: vi.fn(() => ({ id: 'i1', summary: { title: 'GitHub' } })),
      putSealed: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    mocks.openDefaultVault.mockResolvedValue({ id: 'v1' });
    mocks.VaultSync.mockImplementation(function () {
      return v;
    });
    return v;
  }
  const op = (o: Record<string, unknown>) =>
    ask<Record<string, unknown>>('agent://item-request', o);

  it('lists, finds and reports the vault', async () => {
    const v = fakeVault();
    await start(true);
    const list = (await op({ op: 'list' })) as { items: { id: string; hasTotp: boolean }[] };
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ title: 'GitHub', hasTotp: true });
    expect(await op({ op: 'vault' })).toEqual({ vaultId: 'v1' });
    expect(await op({ op: 'find', item: 'github' })).toEqual({
      vaultId: 'v1',
      item: { cipherFor: 'i1' },
    });
    expect(v.pull).toHaveBeenCalled();
    // Same vault id: not constructed again.
    expect(mocks.VaultSync).toHaveBeenCalledTimes(1);
  });

  it('uploads, deletes and lists SSH keys', async () => {
    const v = fakeVault();
    await start(true);
    expect(await op({ op: 'upload', vaultId: 'v1', item: { x: 1 }, created: true })).toEqual({});
    expect(v.putSealed).toHaveBeenCalledWith({ x: 1 });
    expect((await op({ op: 'upload', vaultId: 'other', item: {}, created: true })).error).toBe(
      'That vault is no longer open.',
    );
    expect(await op({ op: 'delete', item: 'github' })).toEqual({
      message: 'Deleted the item “GitHub”.',
    });
    expect(await op({ op: 'sshKeys' })).toEqual({
      vaultId: 'v1',
      sshKeys: [{ cipherFor: 'i1' }],
    });
  });

  it('keeps SSH working offline with the last synced vault', async () => {
    const v = fakeVault();
    await start(true);
    await op({ op: 'vault' });
    mocks.openDefaultVault.mockRejectedValue(new Error('offline'));
    expect(await op({ op: 'sshKeys' })).toMatchObject({ vaultId: 'v1' });
    expect((await op({ op: 'vault' })).error).toBe('offline');
    mocks.openDefaultVault.mockResolvedValue({ id: 'v1' });
    v.pull.mockRejectedValue(new Error('net'));
    expect(await op({ op: 'sshKeys' })).toMatchObject({ vaultId: 'v1' });
    expect((await op({ op: 'vault' })).error).toBe('net');
  });

  it('errors when no vault is available', async () => {
    await start(false);
    expect((await op({ op: 'list' })).error).toBe('The vault is not available in this window.');
  });
});

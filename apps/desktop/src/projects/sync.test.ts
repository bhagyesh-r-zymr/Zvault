import type {
  CreateProjectRequest,
  EncryptedBlob,
  EntryType,
  MyProjectKeysResponse,
  ProjectEntry,
  ProjectRecord,
  PutEnvironmentRequest,
  PutFolderRequest,
  PutSecretRequest,
  SyncProjectResponse,
} from '@zvault/shared';
import { describe, expect, it, vi } from 'vitest';
import type { FindSecret, ListSecrets, SaveSecret } from '../agents/api.js';
import { serveZv } from '../agents/bridge.js';
import { EntryConflictError, type ProjectsApi } from './api.js';
import type { ProjectsCore } from './core.js';
import { secretRef, toView, valueSource, type ProjectState } from './model.js';
import { ProjectsSync } from './sync.js';

const NOW = '2026-01-01T00:00:00.000Z';

/** The environments most tests start with; new projects in the app have none. */
const STARTER = [
  { name: 'Development', kind: 'development' as const },
  { name: 'Staging', kind: 'staging' as const },
  { name: 'Production', kind: 'production' as const },
];

const served = vi.hoisted((): { find?: unknown; list?: unknown; save?: unknown } => ({}));
vi.mock('../agents/api.js', () => {
  const stop = () => Promise.resolve(() => undefined);
  return {
    agents: {
      serveResolves: (f: unknown) => ((served.find = f), stop()),
      serveLists: (l: unknown) => ((served.list = l), stop()),
      serveWrites: (w: unknown) => ((served.save = w), stop()),
    },
  };
});

function blob(kid: string, value: unknown): EncryptedBlob {
  return {
    v: 1,
    alg: 'xchacha20poly1305',
    kid,
    nonce: '',
    ct: btoa(JSON.stringify(value)),
  } as EncryptedBlob;
}

function decode(b: EncryptedBlob): unknown {
  return JSON.parse(atob(b.ct));
}

/** Stands in for the Rust core: "encrypts" by base64-encoding JSON. */
const fakeCore: ProjectsCore = {
  createProject: (meta, environments) => {
    const id = crypto.randomUUID();
    return Promise.resolve({
      id,
      encryptedKey: blob('account', 'key'),
      encryptedMeta: blob(id, meta),
      environments: environments.map((e) => {
        const envId = crypto.randomUUID();
        return {
          id: envId,
          encryptedMeta: blob(envId, e),
          encryptedKey: blob('account', 'key'),
        };
      }),
    });
  },
  openProject: (p) => Promise.resolve(decode(p.encryptedMeta)),
  openEnvironment: (_pid, env) =>
    Promise.resolve({ meta: decode(env.encryptedMeta), unlocked: !!env.encryptedKey }),
  sealEnvironment: (_pid, id, meta) => {
    const envId = id ?? crypto.randomUUID();
    return Promise.resolve({
      id: envId,
      encryptedMeta: blob(envId, meta),
      ...(id === null && { encryptedKey: blob('account', 'key') }),
    });
  },
  sealEntry: (_pid, _kind, id, meta) => {
    const entryId = id ?? crypto.randomUUID();
    return Promise.resolve({ id: entryId, encryptedMeta: blob(entryId, meta) });
  },
  openEntry: (_pid, _kind, _id, meta) => Promise.resolve(decode(meta)),
  sealValue: (_pid, _sid, envId, value) => Promise.resolve(blob(envId, { value })),
  openValue: (_pid, _sid, _envId, b) => Promise.resolve((decode(b) as { value: string }).value),
};

/** Minimal server with the same revision, sequence and key-grant rules as the API. */
class FakeServer {
  projects = new Map<string, ProjectRecord>();
  entries = new Map<string, ProjectEntry>();
  /** Environment ids whose key the caller holds. */
  grants = new Set<string>();
  seq = 0;
  pageSize = 2;
  /** Set to serve the project as shared with the caller through an org. */
  memberKeys: MyProjectKeysResponse | null = null;

  myKeys(): Promise<MyProjectKeysResponse> {
    return this.memberKeys ? Promise.resolve(this.memberKeys) : Promise.reject(new Error('404'));
  }

  listProjects(): Promise<ProjectRecord[]> {
    const shared = (p: ProjectRecord) =>
      this.memberKeys ? { ...p, owner: false, encryptedKey: blob('member-key-wrap', 'key') } : p;
    return Promise.resolve([...this.projects.values()].map(shared));
  }

  createProject(req: CreateProjectRequest): Promise<ProjectRecord> {
    const record: ProjectRecord = {
      id: req.id,
      revision: 1,
      encryptedMeta: req.encryptedMeta,
      encryptedKey: req.encryptedKey,
      owner: true,
      seq: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.projects.set(req.id, record);
    for (const e of req.environments) {
      this.grants.add(e.id);
      void this.save(req.id, e.id, 0, { type: 'environment', encryptedMeta: e.encryptedMeta });
    }
    return Promise.resolve(record);
  }

  syncProject(projectId: string, since: number): Promise<SyncProjectResponse> {
    const changed = [...this.entries.values()]
      .filter((e) => e.projectId === projectId && e.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => this.view(e));
    const entries = changed.slice(0, this.pageSize);
    return Promise.resolve({
      entries,
      cursor: entries.at(-1)?.seq ?? since,
      hasMore: changed.length > this.pageSize,
    });
  }

  putEnvironment(pid: string, id: string, body: PutEnvironmentRequest): Promise<ProjectEntry> {
    if (body.encryptedKey) this.grants.add(id);
    return this.save(pid, id, body.baseRevision, {
      type: 'environment',
      encryptedMeta: body.encryptedMeta,
    });
  }

  putFolder(pid: string, id: string, body: PutFolderRequest): Promise<ProjectEntry> {
    return this.save(pid, id, body.baseRevision, {
      type: 'folder',
      encryptedMeta: body.encryptedMeta,
    });
  }

  putSecret(pid: string, id: string, body: PutSecretRequest): Promise<ProjectEntry> {
    // Like the API, environments left out keep their current value.
    const current = this.entries.get(id);
    const kept = current?.type === 'secret' && !current.deleted ? current.values : [];
    const values = [
      ...kept.filter((v) => !(v.environmentId in body.values)),
      ...Object.entries(body.values).flatMap(([environmentId, v]) =>
        v ? [{ environmentId, encryptedValue: v, updatedAt: NOW }] : [],
      ),
    ];
    return this.save(pid, id, body.baseRevision, {
      type: 'secret',
      encryptedMeta: body.encryptedMeta,
      values,
    });
  }

  deleteEntry(pid: string, type: EntryType, id: string, base: number): Promise<ProjectEntry> {
    const deleted = this.save(pid, id, base, { type, deleted: true });
    if (type === 'environment') {
      // Like the API: the key and every value sealed with it go, without a new seq.
      this.grants.delete(id);
      for (const e of this.entries.values()) {
        if (e.type === 'secret' && !e.deleted) {
          e.values = e.values.filter((v) => v.environmentId !== id);
        }
      }
    }
    return deleted;
  }

  private save(pid: string, id: string, base: number, body: object): Promise<ProjectEntry> {
    const current = this.entries.get(id);
    if ((current?.revision ?? 0) !== base) {
      return Promise.reject(new EntryConflictError(this.view(current!)));
    }
    const entry = {
      deleted: false,
      ...body,
      id,
      projectId: pid,
      revision: base + 1,
      seq: ++this.seq,
      updatedAt: NOW,
    } as ProjectEntry;
    this.entries.set(id, entry);
    return Promise.resolve(this.view(entry));
  }

  /** What the caller sees: no key or values for environments they aren't granted. */
  private view(entry: ProjectEntry): ProjectEntry {
    if (entry.deleted) return entry;
    if (entry.type === 'environment') {
      return {
        ...entry,
        encryptedKey: this.grants.has(entry.id) ? blob('account', 'key') : null,
      };
    }
    if (entry.type === 'secret') {
      return { ...entry, values: entry.values.filter((v) => this.grants.has(v.environmentId)) };
    }
    return entry;
  }
}

const device = (server: FakeServer, core: ProjectsCore = fakeCore) =>
  new ProjectsSync(server as unknown as ProjectsApi, core);

describe('ProjectsSync', () => {
  it('opens a shared project and its environments with the member wraps', async () => {
    const server = new FakeServer();
    const projectId = await device(server).createProject('Shared', STARTER);
    const envIds = [...server.entries.values()].map((e) => e.id);
    const wrap = (keyVersion: number | null) => ({
      recipientId: crypto.randomUUID(),
      recipientPublicKey: 'r',
      wrapperPublicKey: 'w',
      ephemeralPublicKey: 'e',
      blob: blob('member-key-wrap', 'key'),
      keyVersion,
      wrappedBy: crypto.randomUUID(),
    });
    server.memberKeys = {
      projectId,
      projectKey: wrap(null),
      environments: envIds.map((environmentId, i) => ({
        environmentId,
        keyVersion: 1,
        level: i === 2 ? 'needs_approval' : 'use',
        wrap: i === 2 ? null : wrap(1),
      })),
    } as MyProjectKeysResponse;

    const passed: unknown[] = [];
    const member = device(server, {
      ...fakeCore,
      openProject: (p, w) => {
        passed.push(w);
        return fakeCore.openProject(p);
      },
      openEnvironment: (pid, env, w) => {
        passed.push(w);
        return Promise.resolve({ meta: decode(env.encryptedMeta), unlocked: !!w });
      },
    });
    await member.load();
    expect(member.get().projects[0]).toMatchObject({ owner: false });
    expect(member.get().projects[0]!.environments.map((e) => e.locked)).toEqual([
      false,
      false,
      true,
    ]);
    expect(passed[0]).toEqual(server.memberKeys.projectKey);
    expect(passed.slice(1)).toEqual([
      server.memberKeys.environments[0]!.wrap,
      server.memberKeys.environments[1]!.wrap,
      null,
    ]);
  });

  it('creates a project, folder and secret, and another device syncs them in pages', async () => {
    const server = new FakeServer();
    const mine = device(server);
    await mine.load();
    expect(mine.get()).toMatchObject({ status: 'ready', projects: [] });

    const projectId = await mine.createProject('Payments API', STARTER);
    const project = mine.get().projects[0]!;
    expect(project).toMatchObject({ slug: 'payments-api', owner: true });
    expect(project.environments.map((e) => [e.slug, e.short, e.locked])).toEqual([
      ['development', 'Dev', false],
      ['staging', 'Staging', false],
      ['production', 'Prod', false],
    ]);
    const [dev, , prod] = project.environments;

    const folderId = await mine.createFolder(projectId, 'Billing');
    const secretId = await mine.createSecret(projectId, {
      name: 'Stripe secret key',
      key: 'STRIPE_SECRET_KEY',
      folderId,
      tags: ['payments'],
      values: { [dev!.id]: 'sk_test_1', [prod!.id]: 'sk_live_1' },
    });
    const secret = mine.get().secrets[0]!;
    expect(secret).toMatchObject({ id: secretId, folder: { slug: 'billing' }, tags: ['payments'] });
    expect(secretRef(project, prod!, secret)).toBe(
      'zv://payments-api/production/billing/STRIPE_SECRET_KEY',
    );
    expect(await mine.openValue(projectId, secretId, prod!.id)).toBe('sk_live_1');

    // Five entries at two per page.
    const other = device(server);
    await other.load();
    expect(other.get().projects[0]!.environments).toHaveLength(3);
    expect(other.get().secrets[0]).toMatchObject({ name: 'Stripe secret key', key: secret.key });
    expect(await other.openValue(projectId, secretId, dev!.id)).toBe('sk_test_1');
  });

  it('shows environments without a key grant as locked, without their values', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Portal', STARTER);
    const envs = mine.get().projects[0]!.environments;
    await mine.createSecret(projectId, {
      name: 'Auth0',
      key: 'AUTH0_SECRET',
      folderId: null,
      tags: [],
      values: Object.fromEntries(envs.map((e) => [e.id, `v-${e.slug}`])),
    });
    server.grants.delete(envs[2]!.id);

    const member = device(server);
    await member.load();
    const seen = member.get();
    expect(seen.projects[0]!.environments.map((e) => e.locked)).toEqual([false, false, true]);
    expect(Object.keys(seen.secrets[0]!.values)).toEqual([envs[0]!.id, envs[1]!.id]);
  });

  it('re-applies an environment and its values after a key rotation', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Rotated', STARTER);
    const dev = mine.get().projects[0]!.environments[0]!;
    const secretId = await mine.createSecret(projectId, {
      name: 'Token',
      key: 'TOKEN',
      folderId: null,
      tags: [],
      values: { [dev.id]: 'old' },
    });
    const opened: string[] = [];
    const member = device(server, {
      ...fakeCore,
      openEnvironment: (pid, env, w) => {
        opened.push(env.id);
        return fakeCore.openEnvironment(pid, env, w);
      },
    });
    await member.load();
    opened.length = 0;

    // Like the API: new ciphertext, same revisions, moved to the end of the feed.
    for (const id of [dev.id, secretId]) {
      const entry = server.entries.get(id)!;
      const moved = { ...entry, seq: ++server.seq };
      if (moved.type === 'secret' && !moved.deleted) {
        moved.values = [
          { environmentId: dev.id, encryptedValue: blob(dev.id, { value: 'new' }), updatedAt: NOW },
        ];
      }
      server.entries.set(id, moved);
    }
    await member.pull(projectId);
    expect(opened).toEqual([dev.id]);
    expect(await member.openValue(projectId, secretId, dev.id)).toBe('new');
  });

  it('adds a custom environment after the others', async () => {
    const mine = device(new FakeServer());
    const projectId = await mine.createProject('Zvault', STARTER);
    await mine.createEnvironment(projectId, 'QA sandbox');
    const qa = mine.get().projects[0]!.environments.at(-1)!;
    expect(qa).toMatchObject({ slug: 'qa-sandbox', kind: 'custom', position: 3, short: 'QA' });
    expect(qa.locked).toBe(false);
  });

  it('refreshes and rethrows when a delete lost a race', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Mobile', STARTER);
    const dev = mine.get().projects[0]!.environments[0]!;
    const secretId = await mine.createSecret(projectId, {
      name: 'Firebase',
      key: 'FIREBASE_KEY',
      folderId: null,
      tags: [],
      values: { [dev.id]: 'one' },
    });

    // Another device renames it first.
    const other = device(server);
    await other.load();
    const sealed = await fakeCore.sealEntry(projectId, 'secret', secretId, {
      name: 'Firebase config',
      key: 'FIREBASE_KEY',
      folderId: null,
      tags: [],
    });
    await server.putSecret(projectId, secretId, {
      baseRevision: 1,
      encryptedMeta: sealed.encryptedMeta,
      values: {},
    });

    await expect(mine.deleteSecret(projectId, secretId)).rejects.toBeInstanceOf(EntryConflictError);
    expect(mine.get().secrets[0]).toMatchObject({ name: 'Firebase config', revision: 2 });

    await mine.deleteSecret(projectId, secretId);
    expect(mine.get().secrets).toEqual([]);
    await other.pull(projectId);
    expect(other.get().secrets).toEqual([]);
  });

  it('starts a new project with no environments, then adds the first', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Empty');
    expect(mine.get().projects[0]!.environments).toEqual([]);
    await mine.createEnvironment(projectId, { name: 'Prod', slug: 'prod', kind: 'production' });
    expect(mine.get().projects[0]!.environments).toMatchObject([
      { name: 'Prod', slug: 'prod', kind: 'production', position: 0, locked: false },
    ]);
  });

  it('renames an environment and changes its slug, kind and fallback', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Edit', STARTER);
    const [dev, staging, prod] = mine.get().projects[0]!.environments;
    await mine.updateEnvironment(projectId, staging!.id, {
      name: 'QA',
      slug: 'qa',
      kind: 'custom',
      inheritsFrom: dev!.id,
    });
    const other = device(server);
    await other.load();
    expect(other.get().projects[0]!.environments[1]).toMatchObject({
      id: staging!.id,
      name: 'QA',
      slug: 'qa',
      kind: 'custom',
      inheritsFrom: dev!.id,
      revision: 2,
      locked: false,
    });

    await expect(
      mine.updateEnvironment(projectId, prod!.id, { name: 'Prod', slug: 'qa' }),
    ).rejects.toThrow('already uses');
    await expect(
      mine.updateEnvironment(projectId, prod!.id, { name: 'Prod', slug: 'Prod!' }),
    ).rejects.toThrow('slug');
    await expect(
      mine.updateEnvironment(projectId, dev!.id, {
        name: 'Development',
        slug: 'development',
        inheritsFrom: staging!.id,
      }),
    ).rejects.toThrow('fall back to each other');
  });

  it('deletes an environment, its values and secrets left with none', async () => {
    const server = new FakeServer();
    const mine = device(server);
    const projectId = await mine.createProject('Trim', STARTER);
    const [dev, staging, prod] = mine.get().projects[0]!.environments;
    await mine.updateEnvironment(projectId, prod!.id, {
      name: 'Production',
      slug: 'production',
      inheritsFrom: staging!.id,
    });
    await mine.updateEnvironment(projectId, staging!.id, {
      name: 'Staging',
      slug: 'staging',
      inheritsFrom: dev!.id,
    });
    const shared = await mine.createSecret(projectId, {
      name: 'Shared',
      key: 'SHARED',
      folderId: null,
      tags: [],
      values: { [dev!.id]: 'd', [staging!.id]: 's' },
    });
    const only = await mine.createSecret(projectId, {
      name: 'Only staging',
      key: 'ONLY_STAGING',
      folderId: null,
      tags: [],
      values: { [staging!.id]: 's' },
    });
    expect(mine.secretsOnlyIn(projectId, staging!.id)).toEqual([only]);

    await mine.deleteEnvironment(projectId, staging!.id);
    const view = mine.get();
    expect(view.projects[0]!.environments.map((e) => [e.slug, e.inheritsFrom])).toEqual([
      ['development', null],
      ['production', dev!.id],
    ]);
    expect(view.secrets.map((s) => [s.id, Object.keys(s.values)])).toEqual([[shared, [dev!.id]]]);

    const other = device(server);
    await other.load();
    expect(other.get().secrets.map((s) => [s.id, Object.keys(s.values)])).toEqual([
      [shared, [dev!.id]],
    ]);
    expect(other.get().projects[0]!.environments).toHaveLength(2);
  });

  it('gives a second project with the same name its own slug', async () => {
    const mine = device(new FakeServer());
    await mine.createProject('API');
    await mine.createProject('API');
    expect(
      mine
        .get()
        .projects.map((p) => p.slug)
        .sort(),
    ).toEqual(['api', 'api-2']);
  });
});

describe('toView', () => {
  it('resolves inherited values and sorts environments by position', () => {
    const state: ProjectState = {
      id: 'p',
      revision: 1,
      owner: false,
      meta: { name: 'P', slug: 'p' },
      environments: new Map([
        [
          'stg',
          {
            revision: 1,
            unlocked: true,
            meta: {
              name: 'Staging',
              slug: 'staging',
              kind: 'staging',
              position: 1,
              inheritsFrom: 'dev',
            },
          },
        ],
        [
          'dev',
          {
            revision: 1,
            unlocked: true,
            meta: {
              name: 'Development',
              slug: 'development',
              kind: 'development',
              position: 0,
              inheritsFrom: null,
            },
          },
        ],
      ]),
      folders: new Map(),
      secrets: new Map([
        [
          's',
          {
            revision: 1,
            meta: { name: 'S', key: 'S', folderId: 'gone', tags: [] },
            values: { dev: blob('dev', { value: 'x' }) },
          },
        ],
      ]),
    };
    const { projects, secrets } = toView([state]);
    const project = projects[0]!;
    expect(project.environments.map((e) => e.id)).toEqual(['dev', 'stg']);
    expect(secrets[0]!.folder).toBeNull();
    expect(valueSource(project, secrets[0]!, 'stg')).toBe('dev');
    expect(secretRef(project, project.environments[1]!, secrets[0]!)).toBe('zv://p/staging/S');
  });
});

describe('zv bridge', () => {
  it('resolves, lists and writes zv:// paths against synced projects', async () => {
    const server = new FakeServer();
    const mine = device(server);
    await mine.load();
    const projectId = await mine.createProject('Payments API', STARTER);
    const [dev, stg, prod] = mine.get().projects[0]!.environments;
    const folderId = await mine.createFolder(projectId, 'Billing');
    const secretId = await mine.createSecret(projectId, {
      name: 'Stripe',
      key: 'STRIPE_KEY',
      folderId,
      tags: [],
      values: { [dev!.id]: 'sk_test', [prod!.id]: 'sk_live' },
    });
    serveZv(mine);
    const find = served.find as FindSecret;
    const list = served.list as ListSecrets;
    const save = served.save as SaveSecret;

    const found = await find('zv://payments-api/production/billing/STRIPE_KEY');
    expect(found).toMatchObject({ projectId, environmentId: prod!.id, secretId, folderId });
    expect(decode(found!.encryptedValue!)).toEqual({ value: 'sk_live' });
    expect(found!.valueEnvironmentId).toBe(prod!.id);

    // Staging has no value yet; the path still resolves so `zv set` can fill it.
    expect(await find('zv://payments-api/staging/billing/STRIPE_KEY')).toMatchObject({
      secretId,
      encryptedValue: null,
    });
    expect(await find('zv://payments-api/staging/STRIPE_KEY')).toMatchObject({
      secretId: null,
      folderId: null,
    });
    expect(await find('zv://nope/staging/STRIPE_KEY')).toBeNull();
    expect(await find('zv://payments-api/qa/STRIPE_KEY')).toBeNull();
    expect(await find('zv://payments-api/staging/nope/STRIPE_KEY')).toBeNull();

    expect(await list('zv://payments-api/production/*')).toEqual([
      'zv://payments-api/production/billing/STRIPE_KEY',
    ]);
    expect((await list(null)).sort()).toEqual([
      'zv://payments-api/development/billing/STRIPE_KEY',
      'zv://payments-api/production/billing/STRIPE_KEY',
    ]);

    // `zv set` on an existing secret, then on a new one.
    await save({
      reference: 'zv://payments-api/staging/billing/STRIPE_KEY',
      projectId,
      environmentId: stg!.id,
      secretId,
      encryptedValue: await fakeCore.sealValue(projectId, secretId, stg!.id, 'sk_stg'),
      encryptedMeta: null,
      created: false,
    });
    const sealed = await fakeCore.sealEntry(projectId, 'secret', null, {
      name: 'DB_URL',
      key: 'DB_URL',
      folderId: null,
      tags: [],
    });
    await save({
      reference: 'zv://payments-api/development/DB_URL',
      projectId,
      environmentId: dev!.id,
      secretId: sealed.id,
      encryptedValue: await fakeCore.sealValue(projectId, sealed.id, dev!.id, 'postgres://'),
      encryptedMeta: sealed.encryptedMeta,
      created: true,
    });

    const other = device(server);
    await other.load();
    expect(await other.openValue(projectId, secretId, stg!.id)).toBe('sk_stg');
    expect(await other.openValue(projectId, secretId, prod!.id)).toBe('sk_live');
    expect(await other.openValue(projectId, sealed.id, dev!.id)).toBe('postgres://');
    expect(other.get().secrets.find((s) => s.id === secretId)!.name).toBe('Stripe');
  });
});

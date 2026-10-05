/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { ACTIVITY_PAGE_SIZE, type EncryptedBlob } from '@zvault/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  EntryConflictError,
  ForbiddenError,
  ProjectsApi,
  forbiddenMessage,
  writeError,
} from './api.js';

const id = () => crypto.randomUUID();
const NOW = '2026-01-01T00:00:00.000Z';
const b64 = (n: number) => 'A'.repeat(n);
const blob = (kid: string, ctLen = 8): EncryptedBlob => ({
  v: 1 as const,
  alg: 'xchacha20poly1305' as const,
  kid,
  nonce: b64(32) as EncryptedBlob['nonce'],
  ct: b64(ctLen) as EncryptedBlob['ct'],
});
const wrapped = (kid: string) => blob(kid, 64);

function projectRecord() {
  return {
    id: id(),
    revision: 1,
    encryptedMeta: blob('p'),
    encryptedKey: wrapped('account'),
    owner: true,
    seq: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function entry(type: 'folder' | 'secret' | 'environment' = 'folder') {
  return {
    id: id(),
    projectId: id(),
    revision: 1,
    seq: 1,
    updatedAt: NOW,
    type: 'folder' as const,
    deleted: false as const,
    encryptedMeta: blob('f'),
    ...(type !== 'folder' && {}),
  };
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  const api = new ProjectsApi(
    { baseUrl: 'https://api.test', accessToken: () => 'tok' },
    fetchImpl as unknown as typeof fetch,
  );
  return { api, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ProjectsApi', () => {
  it('lists projects with a bearer token', async () => {
    const rec = projectRecord();
    const { api, fetchImpl } = setup(() => json({ projects: [rec] }));
    expect(await api.listProjects()).toEqual([rec]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.test/v1/projects');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('creates, updates and deletes a project', async () => {
    const rec = projectRecord();
    const { api, fetchImpl } = setup((_u, init) =>
      init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(rec),
    );
    await api.createProject({
      id: rec.id,
      encryptedMeta: rec.encryptedMeta,
      encryptedKey: rec.encryptedKey,
      environments: [],
    });
    await api.updateProject(rec.id, { baseRevision: 1, encryptedMeta: rec.encryptedMeta });
    await api.deleteProject(rec.id);
    const calls = fetchImpl.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`);
    expect(calls).toEqual([
      'POST https://api.test/v1/projects',
      `PATCH https://api.test/v1/projects/${rec.id}`,
      `DELETE https://api.test/v1/projects/${rec.id}`,
    ]);
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('syncs changes since a cursor', async () => {
    const { api, fetchImpl } = setup(() => json({ entries: [entry()], cursor: 1, hasMore: false }));
    const res = await api.syncProject('p1', 7);
    expect(res.cursor).toBe(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/projects/p1/changes?since=7');
  });

  it('puts and deletes entries on the right paths', async () => {
    const { api, fetchImpl } = setup(() => json(entry()));
    const meta = { baseRevision: 0, encryptedMeta: blob('x') };
    await api.putEnvironment('p', 'e', meta);
    await api.putFolder('p', 'f', meta);
    await api.putSecret('p', 's', { ...meta, values: {} });
    await api.deleteEntry('p', 'secret', 's', 3);
    await api.deleteEntry('p', 'folder', 'f', 2);
    await api.deleteEntry('p', 'environment', 'e', 1);
    const urls = fetchImpl.mock.calls.map(([u, i]) => `${i?.method} ${String(u).slice(19)}`);
    expect(urls).toEqual([
      'PUT /projects/p/environments/e',
      'PUT /projects/p/folders/f',
      'PUT /projects/p/secrets/s',
      'DELETE /projects/p/secrets/s?baseRevision=3',
      'DELETE /projects/p/folders/f?baseRevision=2',
      'DELETE /projects/p/environments/e?baseRevision=1',
    ]);
  });

  it('reads history and trash', async () => {
    const version = {
      revision: 1,
      savedAt: NOW,
      encryptedMeta: blob('m'),
      values: [{ environmentId: id(), encryptedValue: blob('e') }],
    };
    const { api } = setup((url) =>
      url.endsWith('/history')
        ? json({ versions: [version] })
        : json({
            secrets: [
              { id: id(), revision: 2, deletedAt: NOW, purgeAt: NOW, lastVersion: version },
            ],
          }),
    );
    expect(await api.secretHistory('p', 's')).toHaveLength(1);
    expect(await api.trash('p')).toHaveLength(1);
  });

  it('purges one trashed secret or all', async () => {
    const { api, fetchImpl } = setup(() => new Response(null, { status: 204 }));
    await api.purgeTrash('p', 's');
    await api.purgeTrash('p', null);
    expect(fetchImpl.mock.calls.map(([u]) => String(u).slice(19))).toEqual([
      '/projects/p/trash/s',
      '/projects/p/trash',
    ]);
  });

  it('posts key wraps and approvals', async () => {
    const { api, fetchImpl } = setup(() => new Response(null, { status: 204 }));
    await api.addProjectWraps('p', { wraps: [] as never });
    await api.addEnvironmentWraps('e', { keyVersion: 1, wraps: [] as never });
    await api.approveRequest('r', {} as never);
    expect(fetchImpl.mock.calls.map(([u]) => String(u).slice(19))).toEqual([
      '/access/projects/p/keys',
      '/access/environments/e/keys',
      '/access/requests/r/approve',
    ]);
  });

  it('rotates an environment key', async () => {
    const access = {
      environmentId: id(),
      projectId: id(),
      orgId: id(),
      keyVersion: 2,
      rotationRequired: false,
      myLevel: 'manage',
      grants: [],
      pendingWraps: [],
    };
    const { api } = setup(() => json(access));
    expect((await api.rotateEnvironment('e', {} as never)).keyVersion).toBe(2);
  });

  it('pages the activity log and reports events', async () => {
    const { api, fetchImpl } = setup((url, init) =>
      init.method === 'POST'
        ? new Response(null, { status: 204 })
        : json({ events: [], hasMore: false }),
    );
    await api.activity('p', { before: 10, secretId: 's' }).catch(() => undefined);
    await api.activity('p').catch(() => undefined);
    await api.reportActivity('p', []);
    const first = String(fetchImpl.mock.calls[0]![0]);
    expect(first).toContain(`limit=${ACTIVITY_PAGE_SIZE}`);
    expect(first).toContain('before=10');
    expect(first).toContain('secretId=s');
    expect(String(fetchImpl.mock.calls[1]![0])).not.toContain('before=');
    expect(fetchImpl.mock.calls[2]![1]!.method).toBe('POST');
  });

  it('fetches my keys', async () => {
    const { api } = setup(() => json({}));
    await expect(api.myKeys('p')).rejects.toThrow();
  });

  it('throws an EntryConflictError carrying the current entry', async () => {
    const current = entry();
    const { api } = setup(() => json({ error: 'conflict', current }, 409));
    const err = await api
      .putFolder('p', 'f', { baseRevision: 1, encryptedMeta: blob('x') })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EntryConflictError);
    expect((err as EntryConflictError).current.id).toBe(current.id);
  });

  it('turns 403 into a ForbiddenError by error code', async () => {
    const { api } = setup(() => json({ error: 'owner_only' }, 403));
    const err = await api.deleteProject('p').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(forbiddenMessage('owner_only'));
    const { api: api2 } = setup(() => new Response('nope', { status: 403 }));
    const err2 = await api2.deleteProject('p').catch((e) => e);
    expect(err2.message).toBe(forbiddenMessage(undefined));
  });

  it('throws ApiError for other failures, including a 409 that is not a conflict', async () => {
    const { api } = setup(() => json({}, 409));
    expect(await api.deleteProject('p').catch((e) => e)).toBeInstanceOf(ApiError);
    const { api: api2 } = setup(() => json({}, 500));
    expect((await api2.listProjects().catch((e) => e)).status).toBe(500);
  });
});

describe('writeError', () => {
  it('maps API statuses to readable messages', () => {
    expect(writeError(new ForbiddenError('owner_only'), 'x')).toMatch(/project owner/);
    expect(writeError(new ApiError(403), 'x')).toMatch(/view this environment/);
    expect(writeError(new ApiError(404), 'x')).toMatch(/no longer available/);
    expect(writeError(new ApiError(400), 'x')).toMatch(/turned this down/);
    expect(writeError(new ApiError(500), 'x')).toBe('Request failed (500)');
    expect(writeError(new Error('boom'), 'x')).toBe('boom');
    expect(writeError('weird', 'fallback')).toBe('fallback');
  });
});

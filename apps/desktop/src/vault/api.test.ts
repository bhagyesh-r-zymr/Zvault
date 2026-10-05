import type { PutItemRequest } from '@zvault/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { ApiError, ConflictError, VaultApi } from './api.js';
import { vaultCore } from './core.js';

const DATE = '2026-01-01T00:00:00.000Z';
const BLOB = { v: 1, alg: 'xchacha20poly1305', kid: 'k', nonce: 'A'.repeat(32), ct: 'AAAA' };
const WRAPPED = { ...BLOB, ct: 'A'.repeat(64) };
const ID = '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d';
const live = {
  id: ID,
  vaultId: ID,
  revision: 2,
  seq: 5,
  updatedAt: DATE,
  deleted: false,
  encryptedKey: WRAPPED,
  encryptedData: BLOB,
};

afterEach(() => vi.unstubAllGlobals());

function api(status: number, body: unknown) {
  const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  const a = new VaultApi(
    { baseUrl: 'http://api', accessToken: () => Promise.resolve('tok') },
    fetchImpl as unknown as typeof fetch,
  );
  return { a, fetchImpl };
}

describe('VaultApi', () => {
  it('lists vaults with the bearer token', async () => {
    const { a, fetchImpl } = api(200, { vaults: [] });
    expect(await a.listVaults()).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/v1/vaults');
    expect(init.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('uses the right method and path for item calls', async () => {
    const { a, fetchImpl } = api(200, live);
    const body = {
      baseRevision: 1,
      encryptedKey: live.encryptedKey,
      encryptedData: live.encryptedData,
    } as PutItemRequest;
    await a.putItem(ID, ID, body);
    await a.deleteItem(ID, ID, 3);
    const calls = fetchImpl.mock.calls.map((c) => {
      const [u, i] = c as unknown as [string, RequestInit];
      return `${i.method} ${u.replace('http://api/v1', '')}`;
    });
    expect(calls).toEqual([
      `PUT /vaults/${ID}/items/${ID}`,
      `DELETE /vaults/${ID}/items/${ID}?baseRevision=3`,
    ]);
    const put = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(put[1].headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('syncs, reads history and trash, and purges', async () => {
    let r = api(200, { items: [live], cursor: 5, hasMore: false });
    expect((await r.a.syncItems(ID, 0)).cursor).toBe(5);
    expect(String(r.fetchImpl.mock.calls[0]?.[0])).toContain(`/vaults/${ID}/items?since=0`);

    r = api(200, {
      versions: [
        { revision: 1, savedAt: DATE, encryptedKey: live.encryptedKey, encryptedData: BLOB },
      ],
    });
    expect(await r.a.itemHistory(ID, ID)).toHaveLength(1);

    r = api(200, { items: [] });
    expect(await r.a.trash(ID)).toEqual([]);

    r = api(200, {});
    await r.a.purgeTrash(ID, null);
    await r.a.purgeTrash(ID, 'x');
    expect(String(r.fetchImpl.mock.calls[0]?.[0])).toMatch(/trash$/);
    expect(String(r.fetchImpl.mock.calls[1]?.[0])).toMatch(/trash\/x$/);
  });

  it('creates a vault', async () => {
    const { a } = api(200, { id: ID, encryptedKey: WRAPPED, encryptedMeta: BLOB, createdAt: DATE });
    await expect(
      a.createVault({ id: ID, encryptedKey: BLOB, encryptedMeta: BLOB } as never),
    ).resolves.toBeDefined();
  });

  it('turns a 409 with the current record into ConflictError', async () => {
    const { a } = api(409, { error: 'conflict', current: live });
    const err = await a.deleteItem(ID, ID, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).current.revision).toBe(2);
  });

  it('turns other failures into ApiError', async () => {
    const { a } = api(500, 'oops');
    const err = await a.trash(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    const bad = api(409, { nope: 1 });
    await expect(bad.a.trash(ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('uses global fetch by default', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('{"vaults":[]}', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const a = new VaultApi({ baseUrl: 'http://api', accessToken: () => 't' });
    await a.listVaults();
    expect(spy).toHaveBeenCalled();
  });
});

describe('vaultCore', () => {
  it('invokes the matching Rust commands', async () => {
    const calls = mockCore({
      vault_create: {},
      vault_open: {},
      item_seal: {},
      item_open: {},
      item_summary: {},
      item_totp_code: null,
      item_passkey_test: null,
      item_share_payload: '{}',
      vault_lock: null,
    });
    const v = { id: 'v', encryptedKey: {}, encryptedMeta: {} } as never;
    const i = { id: 'i', encryptedKey: {}, encryptedData: {} } as never;
    await vaultCore.createVault('n');
    await vaultCore.openVault(v);
    await vaultCore.sealItem('v', null, {} as never);
    await vaultCore.openItem('v', i);
    await vaultCore.summarizeItem('v', i);
    await vaultCore.totpCode('v', i);
    await vaultCore.testPasskey('v', i);
    await vaultCore.sharePayload('v', i);
    await vaultCore.lock();
    expect(calls.mock.calls.map((c) => c[0])).toEqual([
      'vault_create',
      'vault_open',
      'item_seal',
      'item_open',
      'item_summary',
      'item_totp_code',
      'item_passkey_test',
      'item_share_payload',
      'vault_lock',
    ]);
  });
});

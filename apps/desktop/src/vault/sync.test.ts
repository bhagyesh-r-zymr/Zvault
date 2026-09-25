import type { EncryptedBlob, ItemRecord, PutItemRequest, SyncItemsResponse } from '@zvault/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError, VaultApi } from './api.js';
import type { ItemCipher, ItemFields, VaultCore } from './core.js';
import { openDefaultVault, VaultSync } from './sync.js';

const VAULT = { id: '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d', name: 'Personal' };

/** Stands in for the Rust core: "encrypts" by base64-encoding JSON. */
const fakeCore: VaultCore = {
  createVault: () => Promise.reject(new Error('unused')),
  openVault: () => Promise.reject(new Error('unused')),
  sealItem: (_vaultId, existing, fields) =>
    Promise.resolve({
      id: existing?.id ?? crypto.randomUUID(),
      encryptedKey: blob('key'),
      encryptedData: blob(JSON.stringify(fields)),
    }),
  openItem: (_vaultId, item) => Promise.resolve(decode(item)),
  summarizeItem: (_vaultId, item) => {
    const f = decode(item);
    return Promise.resolve({
      title: f.title,
      username: f.username,
      url: f.urls[0] ?? null,
      hasTotp: f.totp !== '',
      hasPasskey: f.passkey !== undefined,
    });
  },
  totpCode: (_vaultId, item) =>
    Promise.resolve(decode(item).totp ? { code: '123456', period: 30, remaining: 12 } : null),
  testPasskey: () => Promise.resolve(),
  sharePayload: (_vaultId, item) => Promise.resolve(JSON.stringify(decode(item))),
  lock: () => Promise.resolve(),
};

function blob(text: string): EncryptedBlob {
  return { v: 1, alg: 'xchacha20poly1305', kid: 'k', nonce: '', ct: btoa(text) } as EncryptedBlob;
}

function decode(item: ItemCipher): ItemFields {
  if (item.encryptedData.ct === 'garbage') throw new Error('decryption failed');
  return JSON.parse(atob(item.encryptedData.ct)) as ItemFields;
}

/** Minimal server with the same revision and sequence rules as the API. */
class FakeServer {
  items = new Map<string, ItemRecord>();
  seq = 0;
  pageSize = 2;

  syncItems(_vaultId: string, since: number): Promise<SyncItemsResponse> {
    const changed = [...this.items.values()]
      .filter((i) => i.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const items = changed.slice(0, this.pageSize);
    return Promise.resolve({
      items,
      cursor: items.at(-1)?.seq ?? since,
      hasMore: changed.length > this.pageSize,
    });
  }

  putItem(vaultId: string, id: string, body: PutItemRequest): Promise<ItemRecord> {
    return this.write(vaultId, id, body.baseRevision, body);
  }

  deleteItem(vaultId: string, id: string, baseRevision: number): Promise<ItemRecord> {
    return this.write(vaultId, id, baseRevision, null);
  }

  private write(
    vaultId: string,
    id: string,
    baseRevision: number,
    body: PutItemRequest | null,
  ): Promise<ItemRecord> {
    const current = this.items.get(id);
    if ((current?.revision ?? 0) !== baseRevision) {
      return Promise.reject(current ? new ConflictError(current) : new ApiError(404));
    }
    const base = { id, vaultId, revision: baseRevision + 1, seq: ++this.seq, updatedAt: '' };
    const item: ItemRecord = body
      ? {
          ...base,
          deleted: false,
          encryptedKey: body.encryptedKey,
          encryptedData: body.encryptedData,
        }
      : { ...base, deleted: true };
    this.items.set(id, item);
    return Promise.resolve(item);
  }
}

const login = (title: string, password = 'pw'): ItemFields => ({
  title,
  username: `${title.toLowerCase()}@example.com`,
  password,
  urls: [],
  notes: '',
  totp: '',
});

function device(server: FakeServer) {
  return new VaultSync(server as unknown as VaultApi, fakeCore, VAULT);
}

describe('VaultSync', () => {
  it('creates, edits and deletes items, sorted by title', async () => {
    const sync = device(new FakeServer());
    const b = await sync.save(null, login('Bank'));
    await sync.save(null, login('Amazon'));
    expect(sync.items().map((i) => i.summary.title)).toEqual(['Amazon', 'Bank']);

    await sync.save(b, login('Bank', 'new'));
    expect((await sync.open(b)).password).toBe('new');

    await sync.remove(b);
    expect(sync.items().map((i) => i.summary.title)).toEqual(['Amazon']);
  });

  it('finds items for zv by id or title and uploads what Rust sealed', async () => {
    const sync = device(new FakeServer());
    const gh = await sync.save(null, login('GitHub'));
    await sync.save(null, login('Bank'));
    await sync.save(null, login('bank'));
    expect(sync.find('github').id).toBe(gh);
    expect(sync.find(gh).summary.title).toBe('GitHub');
    expect(() => sync.find('Bank')).toThrow(/2 items/);
    expect(() => sync.find('Nope')).toThrow(/No item/);

    const sealed = await fakeCore.sealItem(VAULT.id, sync.cipher(gh), login('GitHub', 'rotated'));
    await sync.putSealed(sealed);
    expect((await sync.open(gh)).password).toBe('rotated');
    const fresh = await fakeCore.sealItem(VAULT.id, null, login('Stripe'));
    await sync.putSealed(fresh);
    expect(sync.find('Stripe').id).toBe(fresh.id);
  });

  it('pulls other devices’ changes across pages, including deletions', async () => {
    const server = new FakeServer();
    const laptop = device(server);
    const desktop = device(server);
    const ids = [];
    for (const t of ['A', 'B', 'C']) ids.push(await laptop.save(null, login(t)));
    await laptop.remove(ids[1]!);

    await desktop.pull();
    expect(desktop.items().map((i) => i.summary.title)).toEqual(['A', 'C']);

    await laptop.save(ids[0]!, login('A2'));
    await desktop.pull();
    expect(desktop.items().map((i) => i.summary.title)).toEqual(['A2', 'C']);
  });

  it('refreshes to the winning version when an edit conflicts', async () => {
    const server = new FakeServer();
    const laptop = device(server);
    const desktop = device(server);
    const id = await laptop.save(null, login('Mail'));
    await desktop.pull();

    await laptop.save(id, login('Mail', 'from-laptop'));
    await expect(desktop.save(id, login('Mail', 'from-desktop'))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await desktop.open(id)).password).toBe('from-laptop');

    // Retrying on top of the fresh copy succeeds.
    await desktop.save(id, login('Mail', 'from-desktop'));
    await laptop.pull();
    expect((await laptop.open(id)).password).toBe('from-desktop');
  });

  it('skips items it cannot decrypt instead of failing the sync', async () => {
    const server = new FakeServer();
    const sync = device(server);
    await sync.save(null, login('Good'));
    const id = crypto.randomUUID();
    await server.putItem(VAULT.id, id, {
      baseRevision: 0,
      encryptedKey: blob('key'),
      encryptedData: { ...blob(''), ct: 'garbage' } as EncryptedBlob,
    });

    const fresh = device(server);
    await fresh.pull();
    expect(fresh.items().map((i) => i.summary.title)).toEqual(['Good']);
    expect(fresh.unreadable).toBe(1);
  });
});

describe('VaultApi', () => {
  const item: ItemRecord = {
    id: crypto.randomUUID(),
    vaultId: VAULT.id,
    revision: 3,
    seq: 9,
    updatedAt: new Date().toISOString(),
    deleted: true,
  };

  const respond = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('sends the session token and turns 409 into a ConflictError', async () => {
    let auth: string | null = null;
    const api = new VaultApi(
      { baseUrl: 'https://api.test', accessToken: () => 'tok' },
      (_url, init) => {
        auth = new Headers(init?.headers).get('authorization');
        return respond(409, { error: 'conflict', current: item })();
      },
    );
    const err = await api.deleteItem(VAULT.id, item.id, 1).catch((e: unknown) => e);
    expect(auth).toBe('Bearer tok');
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).current.revision).toBe(3);
  });

  it('reports other failures by status', async () => {
    const api = new VaultApi(
      { baseUrl: 'https://api.test', accessToken: () => 'tok' },
      respond(404, {}),
    );
    await expect(api.listVaults()).rejects.toMatchObject({ status: 404 });
  });
});

describe('openDefaultVault', () => {
  it('creates one Personal vault when opened twice at once', async () => {
    const created: unknown[] = [];
    const api = {
      listVaults: () => Promise.resolve(created.length ? [created[0]] : []),
      createVault: (record: unknown) => {
        created.push(record);
        return Promise.resolve(record);
      },
    } as unknown as VaultApi;
    const core = {
      ...fakeCore,
      createVault: () => Promise.resolve({ record: { id: VAULT.id }, summary: VAULT }),
      openVault: () => Promise.resolve(VAULT),
    } as unknown as VaultCore;

    const [a, b] = await Promise.all([openDefaultVault(api, core), openDefaultVault(api, core)]);
    expect(created).toHaveLength(1);
    expect(a).toEqual(VAULT);
    expect(b).toEqual(VAULT);
    await expect(openDefaultVault(api, core)).resolves.toEqual(VAULT);
    expect(created).toHaveLength(1);
  });
});

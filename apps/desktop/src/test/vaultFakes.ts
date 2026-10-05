import type {
  EncryptedBlob,
  ItemRecord,
  ItemVersion,
  PutItemRequest,
  SyncItemsResponse,
  TrashedItem,
} from '@zvault/shared';
import { ApiError, ConflictError, type VaultApi } from '../vault/api.js';
import type { ItemCipher, ItemFields, VaultCore } from '../vault/core.js';

export const VAULT = { id: '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d', name: 'Personal' };

export function blob(text: string): EncryptedBlob {
  return { v: 1, alg: 'xchacha20poly1305', kid: 'k', nonce: '', ct: btoa(text) } as EncryptedBlob;
}

function decode(item: ItemCipher): ItemFields {
  if (item.encryptedData.ct === 'garbage') throw new Error('decryption failed');
  return JSON.parse(atob(item.encryptedData.ct)) as ItemFields;
}

/** Stands in for the Rust core: "encrypts" by base64-encoding JSON. */
export function makeCore(over: Partial<VaultCore> = {}): VaultCore {
  return {
    createVault: (name) =>
      Promise.resolve({
        record: { id: VAULT.id, encryptedKey: blob('k'), encryptedMeta: blob(name) },
        summary: { id: VAULT.id, name },
      }),
    openVault: () => Promise.resolve(VAULT),
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
        urls: f.urls,
        hasTotp: f.totp !== '',
        hasPasskey: f.passkey !== undefined,
        hasSshKey: f.sshKey !== undefined,
      });
    },
    totpCode: () => Promise.resolve({ code: '123456', period: 30, remaining: 20 }),
    testPasskey: () => Promise.resolve(),
    sharePayload: (_vaultId, item) =>
      Promise.resolve(JSON.stringify({ v: 1, title: decode(item).title })),
    lock: () => Promise.resolve(),
    ...over,
  };
}

/** Minimal server with the same revision and sequence rules as the API. */
export class FakeServer {
  items = new Map<string, ItemRecord>();
  versions = new Map<string, ItemVersion[]>();
  seq = 0;
  vaults: { id: string }[] = [VAULT];
  purged: (string | null)[] = [];

  listVaults() {
    return Promise.resolve(this.vaults);
  }

  createVault(record: { id: string }) {
    this.vaults.push(record);
    return Promise.resolve(record);
  }

  syncItems(_vaultId: string, since: number): Promise<SyncItemsResponse> {
    const items = [...this.items.values()]
      .filter((i) => i.seq > since)
      .sort((a, b) => a.seq - b.seq);
    return Promise.resolve({ items, cursor: items.at(-1)?.seq ?? since, hasMore: false });
  }

  putItem(vaultId: string, id: string, body: PutItemRequest): Promise<ItemRecord> {
    return this.write(vaultId, id, body.baseRevision, body);
  }

  deleteItem(vaultId: string, id: string, baseRevision: number): Promise<ItemRecord> {
    return this.write(vaultId, id, baseRevision, null);
  }

  itemHistory(_vaultId: string, id: string): Promise<ItemVersion[]> {
    return Promise.resolve([...(this.versions.get(id) ?? [])].reverse());
  }

  trash(): Promise<TrashedItem[]> {
    const day = 24 * 3600 * 1000;
    const trashed = [...this.items.values()].flatMap((i) => {
      const last = this.versions.get(i.id)?.at(-1);
      return i.deleted && last
        ? [
            {
              id: i.id,
              revision: i.revision,
              deletedAt: new Date(Date.now() - 2 * day).toISOString(),
              purgeAt: new Date(Date.now() + 28 * day).toISOString(),
              lastVersion: last,
            },
          ]
        : [];
    });
    return Promise.resolve(trashed);
  }

  purgeTrash(_vaultId: string, id: string | null): Promise<void> {
    this.purged.push(id);
    for (const i of this.items.values())
      if (i.deleted && (id ?? i.id) === i.id) this.versions.delete(i.id);
    return Promise.resolve();
  }

  /** Behaves like another device editing the item. */
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
    if (current && !current.deleted) {
      const kept = this.versions.get(id) ?? [];
      kept.push({
        revision: current.revision,
        savedAt: new Date().toISOString(),
        encryptedKey: current.encryptedKey,
        encryptedData: current.encryptedData,
      });
      this.versions.set(id, kept);
    }
    const base = {
      id,
      vaultId,
      revision: baseRevision + 1,
      seq: ++this.seq,
      updatedAt: new Date().toISOString(),
    };
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

  asApi(): VaultApi {
    return this as unknown as VaultApi;
  }
}

export const login = (
  title: string,
  password = 'pw',
  extra: Partial<ItemFields> = {},
): ItemFields => ({
  title,
  username: `${title.toLowerCase()}@example.com`,
  password,
  urls: [],
  notes: '',
  totp: '',
  ...extra,
});

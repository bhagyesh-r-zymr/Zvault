import {
  API_VERSION,
  ItemConflictResponse,
  ItemHistoryResponse,
  ItemRecord,
  ListVaultsResponse,
  SyncItemsResponse,
  VaultRecord,
  VaultTrashResponse,
  type CreateVaultRequest,
  type ItemVersion,
  type TrashedItem,
  type PutItemRequest,
} from '@zvault/shared';

export interface ApiSession {
  /** API origin, e.g. `https://api.zvault.example`. */
  baseUrl: string;
  /** Returns the current session token; provided by the login flow. */
  accessToken: () => string | Promise<string>;
}

/** Thrown when an edit was based on a revision someone else already replaced. */
export class ConflictError extends Error {
  constructor(readonly current: ItemRecord) {
    super('This item was changed on another device.');
  }
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`);
  }
}

/** HTTP client for the vault routes. Every body it sends is ciphertext. */
export class VaultApi {
  constructor(
    private readonly session: ApiSession,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async listVaults(): Promise<VaultRecord[]> {
    return ListVaultsResponse.parse(await this.request('GET', '/vaults')).vaults;
  }

  async createVault(body: CreateVaultRequest): Promise<VaultRecord> {
    return VaultRecord.parse(await this.request('POST', '/vaults', body));
  }

  async syncItems(vaultId: string, since: number): Promise<SyncItemsResponse> {
    const path = `/vaults/${vaultId}/items?since=${since}`;
    return SyncItemsResponse.parse(await this.request('GET', path));
  }

  async putItem(vaultId: string, itemId: string, body: PutItemRequest): Promise<ItemRecord> {
    return ItemRecord.parse(await this.request('PUT', `/vaults/${vaultId}/items/${itemId}`, body));
  }

  async deleteItem(vaultId: string, itemId: string, baseRevision: number): Promise<ItemRecord> {
    const path = `/vaults/${vaultId}/items/${itemId}?baseRevision=${baseRevision}`;
    return ItemRecord.parse(await this.request('DELETE', path));
  }

  /** Earlier versions of an item, newest first. */
  async itemHistory(vaultId: string, itemId: string): Promise<ItemVersion[]> {
    const path = `/vaults/${vaultId}/items/${itemId}/history`;
    return ItemHistoryResponse.parse(await this.request('GET', path)).versions;
  }

  /** Items deleted in the last 30 days, newest first. */
  async trash(vaultId: string): Promise<TrashedItem[]> {
    return VaultTrashResponse.parse(await this.request('GET', `/vaults/${vaultId}/trash`)).items;
  }

  /** Deletes one trashed item for good, or empties the trash (`itemId` null). */
  async purgeTrash(vaultId: string, itemId: string | null): Promise<void> {
    await this.request('DELETE', `/vaults/${vaultId}/trash${itemId ? `/${itemId}` : ''}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.session.accessToken()}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.session.baseUrl}/${API_VERSION}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (res.status === 409) {
      const conflict = ItemConflictResponse.safeParse(json);
      if (conflict.success) throw new ConflictError(conflict.data.current);
    }
    if (!res.ok) throw new ApiError(res.status);
    return json;
  }
}

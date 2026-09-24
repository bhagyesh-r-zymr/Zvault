import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateVaultRequest,
  ItemConflictResponse,
  ItemRecord,
  PutItemRequest,
  SyncItemsResponse,
  VaultRecord,
} from '@zvault/shared';
import type { AuthenticatedUser } from './current-user.js';
import { VaultStore, type ItemWrite, type StoredVault } from './vault.store.js';

/** Upper bound on items per vault, to cap storage abuse by one account. */
export const MAX_ITEMS_PER_VAULT = 10_000;

/** `kid` the client uses for the vault key blob wrapped by the account key. */
export const ACCOUNT_KID = 'account';

@Injectable()
export class VaultService {
  constructor(private readonly store: VaultStore) {}

  async createVault(user: AuthenticatedUser, req: CreateVaultRequest): Promise<VaultRecord> {
    if (req.encryptedKey.kid !== ACCOUNT_KID || req.encryptedMeta.kid !== req.id) {
      throw new BadRequestException({ error: 'key_mismatch' });
    }
    const vault: StoredVault = { ...req, ownerId: user.id, createdAt: new Date().toISOString() };
    if (!(await this.store.insertVault(vault))) {
      throw new ConflictException({ error: 'vault_exists' });
    }
    return toVaultRecord(vault);
  }

  async listVaults(user: AuthenticatedUser): Promise<VaultRecord[]> {
    return (await this.store.listVaults(user.id)).map(toVaultRecord);
  }

  async putItem(
    user: AuthenticatedUser,
    vaultId: string,
    itemId: string,
    req: PutItemRequest,
  ): Promise<ItemRecord> {
    await this.assertAccess(user, vaultId);
    // The client binds each blob to its record; a mismatch is a client bug.
    if (req.encryptedKey.kid !== vaultId || req.encryptedData.kid !== itemId) {
      throw new BadRequestException({ error: 'key_mismatch' });
    }
    if (req.baseRevision === 0 && (await this.store.countItems(vaultId)) >= MAX_ITEMS_PER_VAULT) {
      throw new BadRequestException({ error: 'vault_full' });
    }
    return this.write({
      vaultId,
      itemId,
      baseRevision: req.baseRevision,
      blobs: { encryptedKey: req.encryptedKey, encryptedData: req.encryptedData },
      now: new Date(),
    });
  }

  async deleteItem(
    user: AuthenticatedUser,
    vaultId: string,
    itemId: string,
    baseRevision: number,
  ): Promise<ItemRecord> {
    await this.assertAccess(user, vaultId);
    return this.write({ vaultId, itemId, baseRevision, blobs: null, now: new Date() });
  }

  async sync(
    user: AuthenticatedUser,
    vaultId: string,
    since: number,
    limit: number,
  ): Promise<SyncItemsResponse> {
    await this.assertAccess(user, vaultId);
    // Fetch one extra to learn whether another page follows.
    const changes = await this.store.listChanges(vaultId, since, limit + 1);
    const items = changes.slice(0, limit);
    return { items, cursor: items.at(-1)?.seq ?? since, hasMore: changes.length > limit };
  }

  private async write(write: ItemWrite): Promise<ItemRecord> {
    const result = await this.store.putItem(write);
    if (result.ok) return result.item;
    if (!result.current) throw new NotFoundException();
    const body: ItemConflictResponse = { error: 'conflict', current: result.current };
    throw new ConflictException(body);
  }

  /** Other accounts' vaults answer 404, so ids can't be probed. */
  private async assertAccess(user: AuthenticatedUser, vaultId: string): Promise<void> {
    const vault = await this.store.getVault(vaultId);
    if (vault?.ownerId !== user.id) throw new NotFoundException();
  }
}

function toVaultRecord({ id, encryptedKey, encryptedMeta, createdAt }: StoredVault): VaultRecord {
  return { id, encryptedKey, encryptedMeta, createdAt };
}

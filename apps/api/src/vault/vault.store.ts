import { Injectable } from '@nestjs/common';
import type { EncryptedBlob, ItemRecord, VaultRecord } from '@zvault/shared';

export interface StoredVault extends VaultRecord {
  ownerId: string;
}

export interface ItemWrite {
  vaultId: string;
  itemId: string;
  /** The write only applies if the item is currently at this revision (0 = absent). */
  baseRevision: number;
  /** `null` writes a tombstone. */
  blobs: { encryptedKey: EncryptedBlob; encryptedData: EncryptedBlob } | null;
  now: Date;
}

export type ItemWriteResult =
  { ok: true; item: ItemRecord } | { ok: false; current: ItemRecord | undefined };

/**
 * Persistence for vaults and items. Everything stored here is ciphertext or
 * non-secret metadata. Implementations must apply `putItem` atomically: check
 * the revision, bump the vault's change sequence and write the item together.
 */
export abstract class VaultStore {
  abstract insertVault(vault: StoredVault): Promise<boolean>;
  abstract getVault(vaultId: string): Promise<StoredVault | undefined>;
  abstract listVaults(ownerId: string): Promise<StoredVault[]>;
  abstract countItems(vaultId: string): Promise<number>;
  abstract putItem(write: ItemWrite): Promise<ItemWriteResult>;
  /** Items changed after `since`, ordered by `seq`. */
  abstract listChanges(vaultId: string, since: number, limit: number): Promise<ItemRecord[]>;
}

/**
 * In-process store for unit tests. The app uses `DrizzleVaultStore`.
 */
@Injectable()
export class InMemoryVaultStore extends VaultStore {
  private readonly vaults = new Map<string, StoredVault>();
  private readonly items = new Map<string, Map<string, ItemRecord>>();
  private readonly seqs = new Map<string, number>();

  insertVault(vault: StoredVault): Promise<boolean> {
    if (this.vaults.has(vault.id)) return Promise.resolve(false);
    this.vaults.set(vault.id, structuredClone(vault));
    this.items.set(vault.id, new Map());
    this.seqs.set(vault.id, 0);
    return Promise.resolve(true);
  }

  getVault(vaultId: string): Promise<StoredVault | undefined> {
    const vault = this.vaults.get(vaultId);
    return Promise.resolve(vault && structuredClone(vault));
  }

  listVaults(ownerId: string): Promise<StoredVault[]> {
    const owned = [...this.vaults.values()].filter((v) => v.ownerId === ownerId);
    return Promise.resolve(structuredClone(owned));
  }

  countItems(vaultId: string): Promise<number> {
    return Promise.resolve(this.items.get(vaultId)?.size ?? 0);
  }

  putItem({ vaultId, itemId, baseRevision, blobs, now }: ItemWrite): Promise<ItemWriteResult> {
    const items = this.items.get(vaultId);
    if (!items) return Promise.resolve({ ok: false, current: undefined });
    const current = items.get(itemId);
    if ((current?.revision ?? 0) !== baseRevision) {
      return Promise.resolve({ ok: false, current: current && structuredClone(current) });
    }
    const seq = (this.seqs.get(vaultId) ?? 0) + 1;
    this.seqs.set(vaultId, seq);
    const base = {
      id: itemId,
      vaultId,
      revision: baseRevision + 1,
      seq,
      updatedAt: now.toISOString(),
    };
    const item: ItemRecord = blobs
      ? { ...base, deleted: false, ...structuredClone(blobs) }
      : { ...base, deleted: true };
    items.set(itemId, item);
    return Promise.resolve({ ok: true, item: structuredClone(item) });
  }

  listChanges(vaultId: string, since: number, limit: number): Promise<ItemRecord[]> {
    const changed = [...(this.items.get(vaultId)?.values() ?? [])]
      .filter((i) => i.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
    return Promise.resolve(structuredClone(changed));
  }
}

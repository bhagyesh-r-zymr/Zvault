import { Injectable } from '@nestjs/common';
import {
  MAX_VERSIONS_PER_RECORD,
  type EncryptedBlob,
  type ItemRecord,
  type ItemVersion,
  type VaultRecord,
} from '@zvault/shared';

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

/** A deleted item that still has content to restore. */
export interface StoredTrashedItem {
  id: string;
  revision: number;
  deletedAt: Date;
  lastVersion: ItemVersion;
}

export type ItemWriteResult =
  { ok: true; item: ItemRecord } | { ok: false; current: ItemRecord | undefined };

/**
 * Persistence for vaults and items. Everything stored here is ciphertext or
 * non-secret metadata. Implementations must apply `putItem` atomically: check
 * the revision, bump the vault's change sequence, keep the replaced content as
 * a version and write the item together.
 */
export abstract class VaultStore {
  abstract insertVault(vault: StoredVault): Promise<boolean>;
  abstract getVault(vaultId: string): Promise<StoredVault | undefined>;
  abstract listVaults(ownerId: string): Promise<StoredVault[]>;
  abstract countItems(vaultId: string): Promise<number>;
  abstract putItem(write: ItemWrite): Promise<ItemWriteResult>;
  /** Items changed after `since`, ordered by `seq`. */
  abstract listChanges(vaultId: string, since: number, limit: number): Promise<ItemRecord[]>;
  /** Earlier versions of an item, newest first. */
  abstract listVersions(vaultId: string, itemId: string): Promise<ItemVersion[]>;
  /** Deleted items deleted at or after `since` that still have versions, newest first. */
  abstract listTrash(vaultId: string, since: Date): Promise<StoredTrashedItem[]>;
  /**
   * Drops the versions of deleted items: one item (`itemId`), or every item
   * deleted before `before` (`itemId` null). Returns how many items were purged.
   */
  abstract purgeTrash(vaultId: string, itemId: string | null, before: Date): Promise<number>;
  /** Drops the versions of every item, in any vault, deleted before `before`. */
  abstract purgeExpired(before: Date): Promise<void>;
}

/**
 * In-process store for unit tests. The app uses `DrizzleVaultStore`.
 */
@Injectable()
export class InMemoryVaultStore extends VaultStore {
  private readonly vaults = new Map<string, StoredVault>();
  private readonly items = new Map<string, Map<string, ItemRecord>>();
  private readonly seqs = new Map<string, number>();
  /** vault id → item id → versions, oldest first. */
  private readonly versions = new Map<string, Map<string, ItemVersion[]>>();

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
    if (current && !current.deleted) {
      const ofVault = this.versions.get(vaultId) ?? new Map<string, ItemVersion[]>();
      this.versions.set(vaultId, ofVault);
      const list = ofVault.get(itemId) ?? [];
      list.push({
        revision: current.revision,
        savedAt: current.updatedAt,
        encryptedKey: current.encryptedKey,
        encryptedData: current.encryptedData,
      });
      ofVault.set(itemId, list.slice(-MAX_VERSIONS_PER_RECORD));
    }
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

  listVersions(vaultId: string, itemId: string): Promise<ItemVersion[]> {
    const list = this.versions.get(vaultId)?.get(itemId) ?? [];
    return Promise.resolve(structuredClone([...list].reverse()));
  }

  listTrash(vaultId: string, since: Date): Promise<StoredTrashedItem[]> {
    const trashed: StoredTrashedItem[] = [];
    for (const item of this.items.get(vaultId)?.values() ?? []) {
      const last = this.versions.get(vaultId)?.get(item.id)?.at(-1);
      const deletedAt = new Date(item.updatedAt);
      if (!item.deleted || !last || deletedAt < since) continue;
      trashed.push({ id: item.id, revision: item.revision, deletedAt, lastVersion: last });
    }
    trashed.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
    return Promise.resolve(structuredClone(trashed));
  }

  purgeTrash(vaultId: string, itemId: string | null, before: Date): Promise<number> {
    const ofVault = this.versions.get(vaultId);
    let purged = 0;
    for (const item of this.items.get(vaultId)?.values() ?? []) {
      if (!item.deleted || !ofVault?.has(item.id)) continue;
      if (itemId === null ? new Date(item.updatedAt) >= before : item.id !== itemId) continue;
      ofVault.delete(item.id);
      purged += 1;
    }
    return Promise.resolve(purged);
  }

  async purgeExpired(before: Date): Promise<void> {
    for (const vaultId of this.vaults.keys()) await this.purgeTrash(vaultId, null, before);
  }
}

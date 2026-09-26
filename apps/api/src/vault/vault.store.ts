import type { EncryptedBlob, ItemRecord, ItemVersion, VaultRecord } from '@zvault/shared';

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

import { z } from 'zod';
import { EncryptedBlob } from './crypto.js';
import { SecretValueRecord } from './projects.js';
import { RecordId, WrappedKey } from './vault.js';

/**
 * Item and secret history, and the trash. The server keeps the ciphertext a
 * record had before each write, exactly as the client uploaded it. Nothing
 * new is sealed for history: the blobs are bound to their vault and item (or
 * project and secret) ids, not to a revision, so restoring a version is an
 * ordinary write of the old blobs on top of the current revision.
 */

/** Days a deleted item or secret stays in the trash before it is purged. */
export const TRASH_RETENTION_DAYS = 30;

/** Earlier versions kept per item or secret; older ones are dropped on write. */
export const MAX_VERSIONS_PER_RECORD = 20;

export const ItemVersion = z.object({
  /** The revision this content had. */
  revision: z.number().int().min(1),
  /** When this content was written. */
  savedAt: z.iso.datetime(),
  encryptedKey: WrappedKey,
  encryptedData: EncryptedBlob,
});
export type ItemVersion = z.infer<typeof ItemVersion>;

/** Earlier versions of an item, newest first. The live version is not included. */
export const ItemHistoryResponse = z.object({ versions: z.array(ItemVersion) });
export type ItemHistoryResponse = z.infer<typeof ItemHistoryResponse>;

export const TrashedItem = z.object({
  id: RecordId,
  /** The tombstone's revision; restore with it as `baseRevision`. */
  revision: z.number().int().min(1),
  deletedAt: z.iso.datetime(),
  /** When the trash drops it for good. */
  purgeAt: z.iso.datetime(),
  /** The content the item had when it was deleted. */
  lastVersion: ItemVersion,
});
export type TrashedItem = z.infer<typeof TrashedItem>;

/** Items deleted in the last {@link TRASH_RETENTION_DAYS} days, newest first. */
export const VaultTrashResponse = z.object({ items: z.array(TrashedItem) });
export type VaultTrashResponse = z.infer<typeof VaultTrashResponse>;

export const SecretVersion = z.object({
  revision: z.number().int().min(1),
  savedAt: z.iso.datetime(),
  encryptedMeta: EncryptedBlob,
  /** Only values of environments the caller holds a key for. */
  values: z.array(SecretValueRecord.omit({ updatedAt: true })),
});
export type SecretVersion = z.infer<typeof SecretVersion>;

export const SecretHistoryResponse = z.object({ versions: z.array(SecretVersion) });
export type SecretHistoryResponse = z.infer<typeof SecretHistoryResponse>;

export const TrashedSecret = z.object({
  id: RecordId,
  revision: z.number().int().min(1),
  deletedAt: z.iso.datetime(),
  purgeAt: z.iso.datetime(),
  lastVersion: SecretVersion,
});
export type TrashedSecret = z.infer<typeof TrashedSecret>;

export const ProjectTrashResponse = z.object({ secrets: z.array(TrashedSecret) });
export type ProjectTrashResponse = z.infer<typeof ProjectTrashResponse>;

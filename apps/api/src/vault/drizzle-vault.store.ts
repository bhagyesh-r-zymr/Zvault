import { Inject, Injectable } from '@nestjs/common';
import { MAX_VERSIONS_PER_RECORD, type ItemRecord, type ItemVersion } from '@zvault/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import { vaultItems, vaultItemVersions, vaults } from '../db/schema.js';
import {
  VaultStore,
  type ItemWrite,
  type ItemWriteResult,
  type StoredTrashedItem,
  type StoredVault,
} from './vault.store.js';

type VaultRow = typeof vaults.$inferSelect;
type ItemRow = typeof vaultItems.$inferSelect;
type VersionRow = typeof vaultItemVersions.$inferSelect;

const toVersion = (r: VersionRow): ItemVersion => ({
  revision: r.revision,
  savedAt: r.savedAt.toISOString(),
  encryptedKey: r.encryptedKey,
  encryptedData: r.encryptedData,
});

const toVault = (r: VaultRow): StoredVault => ({
  id: r.id,
  ownerId: r.ownerId,
  encryptedKey: r.encryptedKey,
  encryptedMeta: r.encryptedMeta,
  createdAt: r.createdAt.toISOString(),
});

function toItem(r: ItemRow): ItemRecord {
  const base = {
    id: r.id,
    vaultId: r.vaultId,
    revision: r.revision,
    seq: r.seq,
    updatedAt: r.updatedAt.toISOString(),
  };
  return r.deleted || !r.encryptedKey || !r.encryptedData
    ? { ...base, deleted: true }
    : { ...base, deleted: false, encryptedKey: r.encryptedKey, encryptedData: r.encryptedData };
}

/** Vaults and items in Postgres. */
@Injectable()
export class DrizzleVaultStore extends VaultStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {
    super();
  }

  async insertVault(vault: StoredVault): Promise<boolean> {
    const inserted = await this.db
      .insert(vaults)
      .values({
        id: vault.id,
        ownerId: vault.ownerId,
        encryptedKey: vault.encryptedKey,
        encryptedMeta: vault.encryptedMeta,
        createdAt: new Date(vault.createdAt),
      })
      .onConflictDoNothing()
      .returning({ id: vaults.id });
    return inserted.length > 0;
  }

  async getVault(vaultId: string): Promise<StoredVault | undefined> {
    const [row] = await this.db.select().from(vaults).where(eq(vaults.id, vaultId)).limit(1);
    return row && toVault(row);
  }

  async listVaults(ownerId: string): Promise<StoredVault[]> {
    const rows = await this.db
      .select()
      .from(vaults)
      .where(eq(vaults.ownerId, ownerId))
      .orderBy(asc(vaults.createdAt));
    return rows.map(toVault);
  }

  async countItems(vaultId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(vaultItems)
      .where(eq(vaultItems.vaultId, vaultId));
    return row?.n ?? 0;
  }

  putItem({ vaultId, itemId, baseRevision, blobs, now }: ItemWrite): Promise<ItemWriteResult> {
    return this.db.transaction(async (tx) => {
      // Locking the vault row serializes writes, so `seq` is gap-free and ordered.
      const [vault] = await tx
        .select({ seq: vaults.seq })
        .from(vaults)
        .where(eq(vaults.id, vaultId))
        .for('update');
      if (!vault) return { ok: false, current: undefined };
      const [current] = await tx
        .select()
        .from(vaultItems)
        .where(and(eq(vaultItems.vaultId, vaultId), eq(vaultItems.id, itemId)));
      if ((current?.revision ?? 0) !== baseRevision) {
        return { ok: false, current: current && toItem(current) };
      }
      const seq = vault.seq + 1;
      await tx.update(vaults).set({ seq }).where(eq(vaults.id, vaultId));
      if (current && !current.deleted && current.encryptedKey && current.encryptedData) {
        await tx.insert(vaultItemVersions).values({
          vaultId,
          itemId,
          revision: current.revision,
          encryptedKey: current.encryptedKey,
          encryptedData: current.encryptedData,
          savedAt: current.updatedAt,
        });
        // Keep the newest versions only.
        await tx
          .delete(vaultItemVersions)
          .where(
            and(
              eq(vaultItemVersions.vaultId, vaultId),
              eq(vaultItemVersions.itemId, itemId),
              lte(vaultItemVersions.revision, current.revision - MAX_VERSIONS_PER_RECORD),
            ),
          );
      }
      const values = {
        revision: baseRevision + 1,
        seq,
        deleted: blobs === null,
        encryptedKey: blobs?.encryptedKey ?? null,
        encryptedData: blobs?.encryptedData ?? null,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(vaultItems)
        .values({ vaultId, id: itemId, ...values })
        .onConflictDoUpdate({ target: [vaultItems.vaultId, vaultItems.id], set: values })
        .returning();
      return { ok: true, item: toItem(row!) };
    });
  }

  async listChanges(vaultId: string, since: number, limit: number): Promise<ItemRecord[]> {
    const rows = await this.db
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.vaultId, vaultId), gt(vaultItems.seq, since)))
      .orderBy(asc(vaultItems.seq))
      .limit(limit);
    return rows.map(toItem);
  }

  async listVersions(vaultId: string, itemId: string): Promise<ItemVersion[]> {
    const rows = await this.db
      .select()
      .from(vaultItemVersions)
      .where(and(eq(vaultItemVersions.vaultId, vaultId), eq(vaultItemVersions.itemId, itemId)))
      .orderBy(desc(vaultItemVersions.revision));
    return rows.map(toVersion);
  }

  async listTrash(vaultId: string, since: Date): Promise<StoredTrashedItem[]> {
    const rows = await this.db
      .selectDistinctOn([vaultItems.id], { item: vaultItems, version: vaultItemVersions })
      .from(vaultItems)
      .innerJoin(
        vaultItemVersions,
        and(
          eq(vaultItemVersions.vaultId, vaultItems.vaultId),
          eq(vaultItemVersions.itemId, vaultItems.id),
        ),
      )
      .where(
        and(
          eq(vaultItems.vaultId, vaultId),
          eq(vaultItems.deleted, true),
          gte(vaultItems.updatedAt, since),
        ),
      )
      .orderBy(vaultItems.id, desc(vaultItemVersions.revision));
    return rows
      .map(({ item, version }) => ({
        id: item.id,
        revision: item.revision,
        deletedAt: item.updatedAt,
        lastVersion: toVersion(version),
      }))
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  }

  async purgeTrash(vaultId: string, itemId: string | null, before: Date): Promise<number> {
    const deleted = await this.db
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.vaultId, vaultId),
          eq(vaultItems.deleted, true),
          itemId === null ? lt(vaultItems.updatedAt, before) : eq(vaultItems.id, itemId),
        ),
      );
    if (deleted.length === 0) return 0;
    const purged = await this.db
      .delete(vaultItemVersions)
      .where(
        and(
          eq(vaultItemVersions.vaultId, vaultId),
          inArray(
            vaultItemVersions.itemId,
            deleted.map((d) => d.id),
          ),
        ),
      )
      .returning({ itemId: vaultItemVersions.itemId });
    return new Set(purged.map((p) => p.itemId)).size;
  }

  async purgeExpired(before: Date): Promise<void> {
    await this.db.delete(vaultItemVersions).where(
      sql`exists (select 1 from ${vaultItems} where ${vaultItems.vaultId} = ${vaultItemVersions.vaultId}
        and ${vaultItems.id} = ${vaultItemVersions.itemId}
        and ${vaultItems.deleted} and ${vaultItems.updatedAt} < ${before.toISOString()})`,
    );
  }
}

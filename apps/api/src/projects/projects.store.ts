import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_VERSIONS_PER_RECORD,
  type EncryptedBlob,
  type EntryType,
  type ProjectEntry,
  type SecretValueRecord,
  type SecretVersion,
} from '@zvault/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  environmentAccess,
  keyGrants,
  projectEntries,
  projects,
  secretValues,
  secretVersions,
} from '../db/schema.js';

type ProjectRow = typeof projects.$inferSelect;
type EntryRow = typeof projectEntries.$inferSelect;
type VersionRow = typeof secretVersions.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Db = Database | Tx;

export interface StoredProject {
  row: ProjectRow;
  /** The project key wrapped for the account that asked. */
  wrappedKey: EncryptedBlob;
}

/** What one account holds in one project. */
export interface ProjectAccess {
  ownerId: string;
  /** The account holds the project key. */
  member: boolean;
  /** Environments whose keys the account holds. */
  environments: Set<string>;
}

export interface NewProject {
  id: string;
  ownerId: string;
  encryptedMeta: EncryptedBlob;
  encryptedKey: EncryptedBlob;
  environments: { id: string; encryptedMeta: EncryptedBlob; encryptedKey: EncryptedBlob }[];
  now: Date;
}

export interface EntryWrite {
  projectId: string;
  id: string;
  type: EntryType;
  /** The write only applies if the entry is currently at this revision (0 = absent). */
  baseRevision: number;
  /** `null` writes a tombstone. */
  encryptedMeta: EncryptedBlob | null;
  /** Secrets only: environment id → sealed value, or `null` to clear it. */
  values?: Record<string, EncryptedBlob | null>;
  /** Environments only, on create: the environment key wrapped for the writer. */
  keyGrant?: { accountId: string; wrappedKey: EncryptedBlob } | undefined;
  /** Upper bound on live entries of this type, checked on create. */
  limit: number;
  /** The account the result is shaped for (which env keys and values it sees). */
  viewer: string;
  now: Date;
}

/** A deleted secret that still has content to restore. */
export interface StoredTrashedSecret {
  id: string;
  revision: number;
  deletedAt: Date;
  lastVersion: SecretVersion;
}

export type EntryWriteResult =
  | { ok: true; entry: ProjectEntry }
  | { ok: false; reason: 'conflict'; current: ProjectEntry }
  | { ok: false; reason: 'not_found' | 'type_mismatch' | 'limit' | 'unknown_environment' };

/**
 * Projects, their entries and key grants in Postgres. Everything stored is
 * ciphertext or ids. Entry writes lock the project row so the project's
 * change sequence is gap-free and ordered.
 */
@Injectable()
export class ProjectsStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  countOwned(ownerId: string): Promise<number> {
    return this.db
      .select({ n: count() })
      .from(projects)
      .where(eq(projects.ownerId, ownerId))
      .then(([r]) => r?.n ?? 0);
  }

  /** Creates the project, the owner's key grants and the first environments. False if the id is taken. */
  createProject(p: NewProject): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(projects)
        .values({
          id: p.id,
          ownerId: p.ownerId,
          encryptedMeta: p.encryptedMeta,
          seq: p.environments.length,
          createdAt: p.now,
          updatedAt: p.now,
        })
        .onConflictDoNothing()
        .returning({ id: projects.id });
      if (inserted.length === 0) return false;
      await tx.insert(keyGrants).values([
        { projectId: p.id, resourceId: p.id, accountId: p.ownerId, wrappedKey: p.encryptedKey },
        ...p.environments.map((e) => ({
          projectId: p.id,
          resourceId: e.id,
          accountId: p.ownerId,
          wrappedKey: e.encryptedKey,
        })),
      ]);
      if (p.environments.length > 0) {
        await tx.insert(projectEntries).values(
          p.environments.map((e, i) => ({
            projectId: p.id,
            id: e.id,
            type: 'environment' as const,
            revision: 1,
            seq: i + 1,
            encryptedMeta: e.encryptedMeta,
            updatedAt: p.now,
          })),
        );
      }
      return true;
    });
  }

  /** Projects the account holds the project key for. */
  async listProjects(accountId: string): Promise<StoredProject[]> {
    const rows = await this.db
      .select({ row: projects, wrappedKey: keyGrants.wrappedKey })
      .from(keyGrants)
      .innerJoin(projects, eq(keyGrants.resourceId, projects.id))
      .where(eq(keyGrants.accountId, accountId))
      .orderBy(asc(projects.createdAt));
    return rows;
  }

  async getProject(projectId: string, accountId: string): Promise<StoredProject | undefined> {
    const [row] = await this.db
      .select({ row: projects, wrappedKey: keyGrants.wrappedKey })
      .from(projects)
      .innerJoin(
        keyGrants,
        and(eq(keyGrants.resourceId, projects.id), eq(keyGrants.accountId, accountId)),
      )
      .where(eq(projects.id, projectId));
    return row;
  }

  async getAccess(projectId: string, accountId: string): Promise<ProjectAccess | undefined> {
    const [project] = await this.db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return undefined;
    const grants = await this.db
      .select({ resourceId: keyGrants.resourceId })
      .from(keyGrants)
      .where(and(eq(keyGrants.projectId, projectId), eq(keyGrants.accountId, accountId)));
    const ids = new Set(grants.map((g) => g.resourceId));
    const member = ids.delete(projectId);
    return { ownerId: project.ownerId, member, environments: ids };
  }

  /** Replaces the project's metadata if it is at `baseRevision`. */
  async updateProject(
    projectId: string,
    baseRevision: number,
    encryptedMeta: EncryptedBlob,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(projects)
      .set({ encryptedMeta, revision: baseRevision + 1, updatedAt: now })
      .where(and(eq(projects.id, projectId), eq(projects.revision, baseRevision)))
      .returning({ id: projects.id });
    return updated.length > 0;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.db.delete(projects).where(eq(projects.id, projectId));
  }

  writeEntry(w: EntryWrite): Promise<EntryWriteResult> {
    return this.db.transaction(async (tx): Promise<EntryWriteResult> => {
      const [project] = await tx
        .select({ seq: projects.seq })
        .from(projects)
        .where(eq(projects.id, w.projectId))
        .for('update');
      if (!project) return { ok: false, reason: 'not_found' };

      const [current] = await tx
        .select()
        .from(projectEntries)
        .where(and(eq(projectEntries.projectId, w.projectId), eq(projectEntries.id, w.id)));
      if (current && current.type !== w.type) return { ok: false, reason: 'type_mismatch' };
      if ((current?.revision ?? 0) !== w.baseRevision) {
        if (!current) return { ok: false, reason: 'not_found' };
        const [view] = await hydrate(tx, w.projectId, w.viewer, [current]);
        return { ok: false, reason: 'conflict', current: view! };
      }
      // Deleting a tombstone again changes nothing.
      if (w.encryptedMeta === null && current?.deleted) return { ok: false, reason: 'not_found' };

      if (w.encryptedMeta !== null && (!current || current.deleted)) {
        const [live] = await tx
          .select({ n: count() })
          .from(projectEntries)
          .where(
            and(
              eq(projectEntries.projectId, w.projectId),
              eq(projectEntries.type, w.type),
              eq(projectEntries.deleted, false),
            ),
          );
        if ((live?.n ?? 0) >= w.limit) return { ok: false, reason: 'limit' };
      }

      const envIds = Object.keys(w.values ?? {});
      if (envIds.length > 0) {
        const envs = await tx
          .select({ id: projectEntries.id })
          .from(projectEntries)
          .where(
            and(
              eq(projectEntries.projectId, w.projectId),
              eq(projectEntries.type, 'environment'),
              eq(projectEntries.deleted, false),
              inArray(projectEntries.id, envIds),
            ),
          );
        if (envs.length !== envIds.length) return { ok: false, reason: 'unknown_environment' };
      }

      const seq = project.seq + 1;
      await tx.update(projects).set({ seq }).where(eq(projects.id, w.projectId));
      if (w.type === 'secret' && current && !current.deleted && current.encryptedMeta) {
        await keepSecretVersion(tx, current, current.encryptedMeta);
      }
      const values = {
        type: w.type,
        revision: w.baseRevision + 1,
        seq,
        deleted: w.encryptedMeta === null,
        encryptedMeta: w.encryptedMeta,
        updatedAt: w.now,
      };
      const [row] = await tx
        .insert(projectEntries)
        .values({ projectId: w.projectId, id: w.id, ...values })
        .onConflictDoUpdate({ target: [projectEntries.projectId, projectEntries.id], set: values })
        .returning();

      if (w.type === 'environment') {
        if (w.encryptedMeta === null) {
          // The environment's key and every value sealed with it go with it.
          await tx
            .delete(secretValues)
            .where(
              and(eq(secretValues.projectId, w.projectId), eq(secretValues.environmentId, w.id)),
            );
          await tx
            .delete(keyGrants)
            .where(and(eq(keyGrants.projectId, w.projectId), eq(keyGrants.resourceId, w.id)));
          await dropVersionValues(tx, w.projectId, w.id);
          // So do its team grants and access requests (they cascade from this row).
          await tx
            .delete(environmentAccess)
            .where(
              and(
                eq(environmentAccess.projectId, w.projectId),
                eq(environmentAccess.environmentId, w.id),
              ),
            );
        } else if (w.keyGrant) {
          await tx
            .insert(keyGrants)
            .values({
              projectId: w.projectId,
              resourceId: w.id,
              accountId: w.keyGrant.accountId,
              wrappedKey: w.keyGrant.wrappedKey,
            })
            .onConflictDoUpdate({
              target: [keyGrants.projectId, keyGrants.resourceId, keyGrants.accountId],
              set: { wrappedKey: w.keyGrant.wrappedKey },
            });
        }
      }

      if (w.type === 'secret') {
        const ofSecret = and(
          eq(secretValues.projectId, w.projectId),
          eq(secretValues.secretId, w.id),
        );
        if (w.encryptedMeta === null) {
          await tx.delete(secretValues).where(ofSecret);
        } else {
          for (const [environmentId, encryptedValue] of Object.entries(w.values ?? {})) {
            if (encryptedValue === null) {
              await tx
                .delete(secretValues)
                .where(and(ofSecret, eq(secretValues.environmentId, environmentId)));
            } else {
              await tx
                .insert(secretValues)
                .values({
                  projectId: w.projectId,
                  secretId: w.id,
                  environmentId,
                  encryptedValue,
                  updatedAt: w.now,
                })
                .onConflictDoUpdate({
                  target: [
                    secretValues.projectId,
                    secretValues.secretId,
                    secretValues.environmentId,
                  ],
                  set: { encryptedValue, updatedAt: w.now },
                });
            }
          }
        }
      }

      const [view] = await hydrate(tx, w.projectId, w.viewer, [row!]);
      return { ok: true, entry: view! };
    });
  }

  /** Earlier versions of a secret, newest first, with only the values `viewer` can open. */
  async listSecretVersions(
    projectId: string,
    secretId: string,
    viewer: string,
  ): Promise<SecretVersion[]> {
    const rows = await this.db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.projectId, projectId), eq(secretVersions.secretId, secretId)))
      .orderBy(desc(secretVersions.revision));
    const environments = await viewerEnvironments(this.db, projectId, viewer);
    return rows.map((r) => toSecretVersion(r, environments));
  }

  /** Secrets deleted at or after `since` that still have versions, newest first. */
  async listTrash(projectId: string, since: Date, viewer: string): Promise<StoredTrashedSecret[]> {
    const rows = await this.db
      .selectDistinctOn([projectEntries.id], { entry: projectEntries, version: secretVersions })
      .from(projectEntries)
      .innerJoin(
        secretVersions,
        and(
          eq(secretVersions.projectId, projectEntries.projectId),
          eq(secretVersions.secretId, projectEntries.id),
        ),
      )
      .where(
        and(
          eq(projectEntries.projectId, projectId),
          eq(projectEntries.type, 'secret'),
          eq(projectEntries.deleted, true),
          gte(projectEntries.updatedAt, since),
        ),
      )
      .orderBy(projectEntries.id, desc(secretVersions.revision));
    const environments = await viewerEnvironments(this.db, projectId, viewer);
    return rows
      .map(({ entry, version }) => ({
        id: entry.id,
        revision: entry.revision,
        deletedAt: entry.updatedAt,
        lastVersion: toSecretVersion(version, environments),
      }))
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  }

  /**
   * Drops the versions of deleted secrets: one secret (`secretId`), or every
   * secret deleted before `before` (`secretId` null). Returns how many secrets were purged.
   */
  async purgeTrash(projectId: string, secretId: string | null, before: Date): Promise<number> {
    const deleted = await this.db
      .select({ id: projectEntries.id })
      .from(projectEntries)
      .where(
        and(
          eq(projectEntries.projectId, projectId),
          eq(projectEntries.type, 'secret'),
          eq(projectEntries.deleted, true),
          secretId === null
            ? lt(projectEntries.updatedAt, before)
            : eq(projectEntries.id, secretId),
        ),
      );
    if (deleted.length === 0) return 0;
    const purged = await this.db
      .delete(secretVersions)
      .where(
        and(
          eq(secretVersions.projectId, projectId),
          inArray(
            secretVersions.secretId,
            deleted.map((d) => d.id),
          ),
        ),
      )
      .returning({ secretId: secretVersions.secretId });
    return new Set(purged.map((p) => p.secretId)).size;
  }

  /** Drops the versions of every secret, in any project, deleted before `before`. */
  async purgeExpired(before: Date): Promise<void> {
    await this.db.delete(secretVersions).where(
      sql`exists (select 1 from ${projectEntries} where ${projectEntries.projectId} = ${secretVersions.projectId}
        and ${projectEntries.id} = ${secretVersions.secretId}
        and ${projectEntries.deleted} and ${projectEntries.updatedAt} < ${before.toISOString()})`,
    );
  }

  /** Entries changed after `since`, ordered by `seq`, as `viewer` may see them. */
  async listChanges(
    projectId: string,
    viewer: string,
    since: number,
    limit: number,
  ): Promise<ProjectEntry[]> {
    const rows = await this.db
      .select()
      .from(projectEntries)
      .where(and(eq(projectEntries.projectId, projectId), gt(projectEntries.seq, since)))
      .orderBy(asc(projectEntries.seq))
      .limit(limit);
    return hydrate(this.db, projectId, viewer, rows);
  }
}

/** Keeps a secret's content (metadata and every environment's value) before a write replaces it. */
async function keepSecretVersion(tx: Tx, current: EntryRow, encryptedMeta: EncryptedBlob) {
  const valueRows = await tx
    .select({
      environmentId: secretValues.environmentId,
      encryptedValue: secretValues.encryptedValue,
    })
    .from(secretValues)
    .where(
      and(eq(secretValues.projectId, current.projectId), eq(secretValues.secretId, current.id)),
    );
  await tx.insert(secretVersions).values({
    projectId: current.projectId,
    secretId: current.id,
    revision: current.revision,
    encryptedMeta,
    values: Object.fromEntries(valueRows.map((v) => [v.environmentId, v.encryptedValue])),
    savedAt: current.updatedAt,
  });
  await tx
    .delete(secretVersions)
    .where(
      and(
        eq(secretVersions.projectId, current.projectId),
        eq(secretVersions.secretId, current.id),
        lte(secretVersions.revision, current.revision - MAX_VERSIONS_PER_RECORD),
      ),
    );
}

/**
 * Forgets an environment's old values in every secret version: once the
 * environment is deleted or its key rotated, nobody holds the key they were
 * sealed with.
 */
export async function dropVersionValues(db: Db, projectId: string, environmentId: string) {
  await db
    .update(secretVersions)
    .set({ values: sql`${secretVersions.values} - ${environmentId}::text` })
    .where(eq(secretVersions.projectId, projectId));
}

/** Environments `viewer` holds a key for. */
async function viewerEnvironments(db: Db, projectId: string, viewer: string): Promise<Set<string>> {
  const grants = await db
    .select({ resourceId: keyGrants.resourceId })
    .from(keyGrants)
    .where(and(eq(keyGrants.projectId, projectId), eq(keyGrants.accountId, viewer)));
  const ids = new Set(grants.map((g) => g.resourceId));
  ids.delete(projectId);
  return ids;
}

function toSecretVersion(r: VersionRow, environments: Set<string>): SecretVersion {
  return {
    revision: r.revision,
    savedAt: r.savedAt.toISOString(),
    encryptedMeta: r.encryptedMeta,
    values: Object.entries(r.values)
      .filter(([environmentId]) => environments.has(environmentId))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([environmentId, encryptedValue]) => ({ environmentId, encryptedValue })),
  };
}

/**
 * Turns entry rows into wire records for `viewer`: environments carry the
 * viewer's wrapped key (or null), secrets carry only the values of
 * environments the viewer holds a key for.
 */
async function hydrate(
  db: Db,
  projectId: string,
  viewer: string,
  rows: EntryRow[],
): Promise<ProjectEntry[]> {
  const grants = await db
    .select({ resourceId: keyGrants.resourceId, wrappedKey: keyGrants.wrappedKey })
    .from(keyGrants)
    .where(and(eq(keyGrants.projectId, projectId), eq(keyGrants.accountId, viewer)));
  const keyOf = new Map(grants.map((g) => [g.resourceId, g.wrappedKey]));

  const secretIds = rows.filter((r) => r.type === 'secret' && !r.deleted).map((r) => r.id);
  const envIds = [...keyOf.keys()].filter((id) => id !== projectId);
  const valueRows =
    secretIds.length > 0 && envIds.length > 0
      ? await db
          .select()
          .from(secretValues)
          .where(
            and(
              eq(secretValues.projectId, projectId),
              inArray(secretValues.secretId, secretIds),
              inArray(secretValues.environmentId, envIds),
            ),
          )
          .orderBy(asc(secretValues.environmentId))
      : [];
  const valuesOf = new Map<string, SecretValueRecord[]>();
  for (const v of valueRows) {
    const list = valuesOf.get(v.secretId) ?? [];
    list.push({
      environmentId: v.environmentId,
      encryptedValue: v.encryptedValue,
      updatedAt: v.updatedAt.toISOString(),
    });
    valuesOf.set(v.secretId, list);
  }

  return rows.map((r): ProjectEntry => {
    const base = {
      id: r.id,
      projectId: r.projectId,
      revision: r.revision,
      seq: r.seq,
      updatedAt: r.updatedAt.toISOString(),
    };
    if (r.deleted || !r.encryptedMeta) return { ...base, type: r.type, deleted: true };
    const encryptedMeta = r.encryptedMeta;
    switch (r.type) {
      case 'environment':
        return {
          ...base,
          type: 'environment',
          deleted: false,
          encryptedMeta,
          encryptedKey: keyOf.get(r.id) ?? null,
        };
      case 'folder':
        return { ...base, type: 'folder', deleted: false, encryptedMeta };
      case 'secret':
        return {
          ...base,
          type: 'secret',
          deleted: false,
          encryptedMeta,
          values: valuesOf.get(r.id) ?? [],
        };
    }
  });
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AccessLevel, OrgRole } from '@zvault/shared';
import { holdsKey, levelAtLeast } from '@zvault/shared';
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  agents,
  environmentAccess,
  environmentGrants,
  groupMembers,
  keyGrants,
  orgGroups,
  orgMembers,
  projectEntries,
  projectOrgs,
  projects,
} from '../db/schema.js';
import { allLevels, effectiveLevel, holderKey, type GrantFacts, type OrgFacts } from './levels.js';

export type EnvironmentRow = typeof environmentAccess.$inferSelect;

/** A member or agent: the principals with keys of their own. */
export interface KeyHolder {
  type: 'account' | 'agent';
  id: string;
}

export interface LinkedProject {
  projectId: string;
  orgId: string;
  ownerId: string;
}

export const ADMIN_ROLES: readonly OrgRole[] = ['owner', 'admin'];

/**
 * Loads who is in an org and what they may reach, and keeps the projects
 * module's key grants in line with it.
 */
@Injectable()
export class AccessFacts {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The caller's membership. Non-members get the same 404 as a missing org so
   * org ids can't be probed.
   */
  async member(orgId: string, accountId: string, opts: { active?: boolean } = {}) {
    const [row] = await this.db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.accountId, accountId)));
    if (!row || (opts.active !== false && !row.publicKey)) throw new NotFoundException();
    return row;
  }

  /** The org a project is shared with, if any. */
  async linkedProject(projectId: string): Promise<LinkedProject | undefined> {
    const [row] = await this.db
      .select({
        projectId: projectOrgs.projectId,
        orgId: projectOrgs.orgId,
        ownerId: projects.ownerId,
      })
      .from(projectOrgs)
      .innerJoin(projects, eq(projects.id, projectOrgs.projectId))
      .where(eq(projectOrgs.projectId, projectId));
    return row;
  }

  /** Live environment ids of a project. */
  async environmentIds(projectId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: projectEntries.id })
      .from(projectEntries)
      .where(
        and(
          eq(projectEntries.projectId, projectId),
          eq(projectEntries.type, 'environment'),
          eq(projectEntries.deleted, false),
        ),
      );
    return rows.map((r) => r.id);
  }

  /**
   * Makes sure every live environment of a linked project has an access row.
   * Environments are registered the first time access looks at them; whoever
   * holds the key at that point (its creator) becomes its manager.
   */
  async register(project: LinkedProject, now: Date): Promise<EnvironmentRow[]> {
    const ids = await this.environmentIds(project.projectId);
    if (ids.length === 0) return [];
    const known = await this.db
      .select()
      .from(environmentAccess)
      .where(inArray(environmentAccess.environmentId, ids));
    const missing = ids.filter((id) => !known.some((k) => k.environmentId === id));
    if (missing.length > 0) {
      const holders = await this.db
        .select({ resourceId: keyGrants.resourceId, accountId: keyGrants.accountId })
        .from(keyGrants)
        .where(
          and(eq(keyGrants.projectId, project.projectId), inArray(keyGrants.resourceId, missing)),
        );
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(environmentAccess)
          .values(
            missing.map((environmentId) => ({
              environmentId,
              projectId: project.projectId,
              orgId: project.orgId,
              createdAt: now,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: environmentAccess.environmentId });
        const fresh = new Set(inserted.map((r) => r.id));
        const grants = holders.filter((h) => fresh.has(h.resourceId));
        if (grants.length > 0) {
          await tx
            .insert(environmentGrants)
            .values(
              grants.map((h) => ({
                environmentId: h.resourceId,
                principalType: 'account' as const,
                principalId: h.accountId,
                level: 'manage' as const,
                grantedBy: h.accountId,
                createdAt: now,
              })),
            )
            .onConflictDoNothing();
        }
      });
    }
    return this.db
      .select()
      .from(environmentAccess)
      .where(inArray(environmentAccess.environmentId, ids))
      .orderBy(environmentAccess.createdAt, environmentAccess.environmentId);
  }

  /** An environment of a linked project, registering it on first use. */
  async environment(
    environmentId: string,
    now = new Date(),
  ): Promise<EnvironmentRow & { ownerId: string }> {
    const [entry] = await this.db
      .select({ projectId: projectEntries.projectId })
      .from(projectEntries)
      .where(
        and(
          eq(projectEntries.id, environmentId),
          eq(projectEntries.type, 'environment'),
          eq(projectEntries.deleted, false),
        ),
      );
    const project = entry && (await this.linkedProject(entry.projectId));
    if (!project) throw new NotFoundException();
    const env = (await this.register(project, now)).find((e) => e.environmentId === environmentId);
    if (!env) throw new NotFoundException();
    return { ...env, ownerId: project.ownerId };
  }

  async org(
    orgId: string,
    projectOwnerId?: string,
  ): Promise<OrgFacts & { keys: Map<string, string> }> {
    const [members, memberships, agentRows] = await Promise.all([
      this.db
        .select({ accountId: orgMembers.accountId, publicKey: orgMembers.publicKey })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), isNotNull(orgMembers.publicKey))),
      this.db
        .select({ groupId: groupMembers.groupId, accountId: groupMembers.accountId })
        .from(groupMembers)
        .innerJoin(orgGroups, eq(orgGroups.id, groupMembers.groupId))
        .where(eq(orgGroups.orgId, orgId)),
      this.db
        .select({ id: agents.id, publicKey: agents.publicKey })
        .from(agents)
        .where(eq(agents.orgId, orgId)),
    ]);
    const groupsOf = new Map<string, string[]>();
    for (const m of memberships) {
      groupsOf.set(m.accountId, [...(groupsOf.get(m.accountId) ?? []), m.groupId]);
    }
    const keys = new Map<string, string>();
    for (const m of members) keys.set(holderKey('account', m.accountId), m.publicKey!);
    for (const a of agentRows) keys.set(holderKey('agent', a.id), a.publicKey);
    return {
      projectOwnerId,
      activeMembers: new Set(members.map((m) => m.accountId)),
      groupsOf,
      agents: new Set(agentRows.map((a) => a.id)),
      keys,
    };
  }

  async grants(environmentId: string): Promise<GrantFacts[]> {
    return this.db
      .select()
      .from(environmentGrants)
      .where(eq(environmentGrants.environmentId, environmentId));
  }

  async levelOf(
    env: EnvironmentRow & { ownerId: string },
    holder: KeyHolder,
    now: Date,
  ): Promise<AccessLevel> {
    const [grants, org] = await Promise.all([
      this.grants(env.environmentId),
      this.org(env.orgId, env.ownerId),
    ]);
    return effectiveLevel(holder, grants, org, now);
  }

  /** Every member's level in every environment of a linked project. */
  async projectLevels(project: LinkedProject, now: Date) {
    const envs = await this.register(project, now);
    const org = await this.org(project.orgId, project.ownerId);
    const byEnv = new Map<string, Map<string, AccessLevel>>();
    for (const env of envs) {
      byEnv.set(env.environmentId, allLevels(await this.grants(env.environmentId), org, now));
    }
    return { envs, org, byEnv };
  }

  /**
   * Accounts that should hold the project key: the owner, org owners and
   * admins, and anyone with at least `needs_approval` in some environment.
   */
  async projectKeyHolders(project: LinkedProject, now: Date): Promise<Set<string>> {
    const { byEnv } = await this.projectLevels(project, now);
    const admins = await this.db
      .select({ id: orgMembers.accountId })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, project.orgId),
          isNotNull(orgMembers.publicKey),
          inArray(orgMembers.role, [...ADMIN_ROLES]),
        ),
      );
    const out = new Set<string>([project.ownerId, ...admins.map((a) => a.id)]);
    for (const levels of byEnv.values()) {
      for (const [key, level] of levels) {
        if (key.startsWith('account:') && levelAtLeast(level, 'needs_approval')) {
          out.add(key.slice('account:'.length));
        }
      }
    }
    return out;
  }

  /**
   * Deletes the key grants of everyone who no longer has standing access to
   * an environment (or any reason to hold the project key), and flags each
   * environment that lost a holder for rotation: they may have kept a copy,
   * so a manager's device should move it to a new key.
   *
   * Runs after every change that can take access away, and before reads
   * (here and in the projects API), so grants that expired take effect.
   */
  async reconcileProject(projectId: string, now: Date): Promise<void> {
    const project = await this.linkedProject(projectId);
    if (!project) return;
    const { envs, byEnv } = await this.projectLevels(project, now);
    const keepProject = await this.projectKeyHolders(project, now);
    const held = await this.db
      .select({ resourceId: keyGrants.resourceId, accountId: keyGrants.accountId })
      .from(keyGrants)
      .where(eq(keyGrants.projectId, projectId));

    const drop: { resourceId: string; accountId: string }[] = [];
    const flagged = new Set<string>();
    for (const g of held) {
      if (g.resourceId === projectId) {
        if (!keepProject.has(g.accountId)) drop.push(g);
        continue;
      }
      const levels = byEnv.get(g.resourceId);
      if (!levels) continue;
      if (!holdsKey(levels.get(holderKey('account', g.accountId)) ?? 'none')) {
        drop.push(g);
        flagged.add(g.resourceId);
      }
    }
    if (drop.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const g of drop) {
        await tx
          .delete(keyGrants)
          .where(
            and(
              eq(keyGrants.projectId, projectId),
              eq(keyGrants.resourceId, g.resourceId),
              eq(keyGrants.accountId, g.accountId),
            ),
          );
      }
      const ids = envs.map((e) => e.environmentId).filter((id) => flagged.has(id));
      if (ids.length > 0) {
        await tx
          .update(environmentAccess)
          .set({ rotationRequiredAt: now })
          .where(
            and(
              inArray(environmentAccess.environmentId, ids),
              isNull(environmentAccess.rotationRequiredAt),
            ),
          );
      }
    });
  }

  async reconcileOrg(orgId: string, now: Date): Promise<void> {
    const linked = await this.db
      .select({ id: projectOrgs.projectId })
      .from(projectOrgs)
      .where(eq(projectOrgs.orgId, orgId));
    for (const p of linked) await this.reconcileProject(p.id, now);
  }

  /** Removes grants to principals that no longer exist (deleted groups, agents, members). */
  async dropGrantsTo(type: 'account' | 'group' | 'agent', ids: readonly string[], orgId: string) {
    if (ids.length === 0) return;
    const envs = this.db
      .select({ id: environmentAccess.environmentId })
      .from(environmentAccess)
      .where(eq(environmentAccess.orgId, orgId));
    await this.db
      .delete(environmentGrants)
      .where(
        and(
          eq(environmentGrants.principalType, type),
          inArray(environmentGrants.principalId, [...ids]),
          inArray(environmentGrants.environmentId, envs),
        ),
      );
  }

  /** An active owner or admin of the org. */
  async isAdmin(orgId: string, accountId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.accountId, accountId),
          isNotNull(orgMembers.publicKey),
          ne(orgMembers.role, 'member'),
        ),
      );
    return !!row;
  }
}

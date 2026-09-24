import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AccessLevel, OrgRole } from '@zvault/shared';
import { holdsKey } from '@zvault/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  agents,
  environmentAccess,
  environmentGrants,
  environmentKeyWraps,
  groupMembers,
  orgGroups,
  orgMembers,
} from '../db/schema.js';
import { allLevels, effectiveLevel, holderKey, type GrantFacts, type OrgFacts } from './levels.js';

export type EnvironmentRow = typeof environmentAccess.$inferSelect;
export type MemberRow = typeof orgMembers.$inferSelect;

/** A member or agent: the principals that can hold a wrapped key. */
export interface KeyHolder {
  type: 'account' | 'agent';
  id: string;
}

export const ADMIN_ROLES: readonly OrgRole[] = ['owner', 'admin'];

/** Loads who is in an org and what they may reach; keeps key wraps in line with it. */
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

  async environment(environmentId: string): Promise<EnvironmentRow> {
    const [env] = await this.db
      .select()
      .from(environmentAccess)
      .where(eq(environmentAccess.environmentId, environmentId));
    if (!env) throw new NotFoundException();
    return env;
  }

  async org(orgId: string): Promise<OrgFacts & { keys: Map<string, string> }> {
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

  async levelOf(env: EnvironmentRow, holder: KeyHolder, now: Date): Promise<AccessLevel> {
    const [grants, org] = await Promise.all([this.grants(env.environmentId), this.org(env.orgId)]);
    return effectiveLevel(holder, grants, org, now);
  }

  /**
   * Deletes every wrapped key (any version) held by someone who no longer has
   * standing access, and flags the environment for rotation if any went: they
   * may have kept a copy, so the next write should be under a new key.
   * Runs after every change that can take access away, and before reads so
   * grants that expired in the meantime take effect.
   */
  async reconcile(environmentIds: readonly string[], now: Date): Promise<void> {
    for (const environmentId of environmentIds) {
      const env = await this.environment(environmentId);
      const [grants, org] = await Promise.all([this.grants(environmentId), this.org(env.orgId)]);
      const levels = allLevels(grants, org, now);
      const wraps = await this.db
        .select({
          principalType: environmentKeyWraps.principalType,
          principalId: environmentKeyWraps.principalId,
        })
        .from(environmentKeyWraps)
        .where(eq(environmentKeyWraps.environmentId, environmentId));
      const lost = new Map<string, { type: 'account' | 'agent'; id: string }>();
      for (const w of wraps) {
        if (w.principalType === 'group') continue;
        const key = holderKey(w.principalType, w.principalId);
        if (!holdsKey(levels.get(key) ?? 'none')) {
          lost.set(key, { type: w.principalType, id: w.principalId });
        }
      }
      if (lost.size === 0) continue;
      await this.db.transaction(async (tx) => {
        for (const h of lost.values()) {
          await tx
            .delete(environmentKeyWraps)
            .where(
              and(
                eq(environmentKeyWraps.environmentId, environmentId),
                eq(environmentKeyWraps.principalType, h.type),
                eq(environmentKeyWraps.principalId, h.id),
              ),
            );
        }
        await tx
          .update(environmentAccess)
          .set({ rotationRequiredAt: now })
          .where(
            and(
              eq(environmentAccess.environmentId, environmentId),
              isNull(environmentAccess.rotationRequiredAt),
            ),
          );
      });
    }
  }

  async reconcileOrg(orgId: string, now: Date): Promise<void> {
    const envs = await this.db
      .select({ id: environmentAccess.environmentId })
      .from(environmentAccess)
      .where(eq(environmentAccess.orgId, orgId));
    await this.reconcile(
      envs.map((e) => e.id),
      now,
    );
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
}

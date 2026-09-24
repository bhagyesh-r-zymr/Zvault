import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ACCESS_LIMITS,
  holdsKey,
  levelAtLeast,
  type AccessLevel,
  type AccessRequestView,
  type AddEnvironmentWrapsRequest,
  type AddProjectWrapsRequest,
  type ApproveAccessRequest,
  type CreateAccessRequest,
  type EnvironmentAccess,
  type Grant,
  type LinkProjectRequest,
  type ListAccessRequestsResponse,
  type MemberKeyWrap,
  type MyProjectKeysResponse,
  type PendingWrap,
  type PrincipalRef,
  type ProjectAccessResponse,
  type PutGrantRequest,
  type RotateEnvironmentKeyRequest,
  type StoredMemberWrap,
} from '@zvault/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  accessRequests,
  accounts,
  agents,
  environmentAccess,
  environmentGrants,
  keyGrants,
  orgGroups,
  orgMembers,
  projectEntries,
  projectOrgs,
  projects,
  secretValues,
  type MemberWrapBox,
} from '../db/schema.js';
import {
  ADMIN_ROLES,
  AccessFacts,
  type EnvironmentRow,
  type KeyHolder,
  type LinkedProject,
} from './access.facts.js';
import { ACCESS_CLOCK, type Clock } from './clock.js';
import { allLevels, effectiveLevel, holderKey, type GrantFacts } from './levels.js';

type GrantRow = typeof environmentGrants.$inferSelect;
type RequestRow = typeof accessRequests.$inferSelect;
type Env = EnvironmentRow & { ownerId: string };

const toGrant = (g: GrantRow): Grant => ({
  principal: { type: g.principalType, id: g.principalId },
  level: g.level,
  expiresAt: g.expiresAt?.toISOString() ?? null,
  grantedBy: g.grantedBy,
  createdAt: g.createdAt.toISOString(),
});

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === '23505' ||
  (e as { cause?: { code?: string } }).cause?.code === '23505';

/**
 * Who can reach each environment of a project shared with an organization,
 * and the member-wrapped copies of its keys, stored as the projects module's
 * key grants.
 *
 * The server decides who may *fetch* a grant, but never holds an unwrapped
 * key: wraps are made on a manager's device, and when someone loses access
 * their grants are deleted and the environment is flagged until a manager's
 * device rotates it to a new key.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCESS_CLOCK) private readonly now: Clock,
    private readonly facts: AccessFacts,
  ) {}

  // ------------------------------------------------------------ projects

  /** Shares a project with an org. Only the project's owner, an active member, can. */
  async linkProject(
    accountId: string,
    projectId: string,
    req: LinkProjectRequest,
  ): Promise<ProjectAccessResponse> {
    const [project] = await this.db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project || project.ownerId !== accountId) throw new NotFoundException();
    await this.facts.member(req.orgId, accountId);
    try {
      await this.db
        .insert(projectOrgs)
        .values({ projectId, orgId: req.orgId, linkedBy: accountId, createdAt: this.now() });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Already shared with an organization');
      throw e;
    }
    return this.project(accountId, projectId);
  }

  /** The linked project the caller can see, reconciled against expiry. */
  private async visibleProject(accountId: string, projectId: string) {
    const project = await this.facts.linkedProject(projectId);
    if (!project) throw new NotFoundException();
    const me = await this.facts.member(project.orgId, accountId);
    const now = this.now();
    await this.facts.reconcileProject(projectId, now);
    return { project, me, now };
  }

  /** Can hand out the project key: holds it and is the owner, an admin, or a manager somewhere. */
  private async canWrapProjectKey(
    project: LinkedProject,
    accountId: string,
    role: string,
    now: Date,
  ): Promise<boolean> {
    const [held] = await this.db
      .select({ a: keyGrants.accountId })
      .from(keyGrants)
      .where(
        and(
          eq(keyGrants.projectId, project.projectId),
          eq(keyGrants.resourceId, project.projectId),
          eq(keyGrants.accountId, accountId),
        ),
      );
    if (!held) return false;
    if (project.ownerId === accountId || ADMIN_ROLES.includes(role as never)) return true;
    const { byEnv } = await this.facts.projectLevels(project, now);
    return [...byEnv.values()].some((l) => l.get(holderKey('account', accountId)) === 'manage');
  }

  /** The "Project access" matrix: raw grants per principal and environment. */
  async project(accountId: string, projectId: string): Promise<ProjectAccessResponse> {
    const { project, me, now } = await this.visibleProject(accountId, projectId);
    const envs = await this.facts.register(project, now);
    const ids = envs.map((e) => e.environmentId);
    const grants = ids.length
      ? await this.db
          .select()
          .from(environmentGrants)
          .where(inArray(environmentGrants.environmentId, ids))
      : [];

    const principals = new Map<string, PrincipalRef>();
    for (const g of grants) {
      principals.set(`${g.principalType}:${g.principalId}`, {
        type: g.principalType,
        id: g.principalId,
      });
    }
    const names = await this.names([...principals.values()]);
    const order = { group: 0, account: 1, agent: 2 } as const;
    const rows = [...principals.entries()]
      .map(([key, principal]) => ({
        principal,
        name: names.get(key) ?? 'Removed',
        cells: envs.map((e) => {
          const g = grants.find(
            (x) =>
              x.environmentId === e.environmentId && `${x.principalType}:${x.principalId}` === key,
          );
          const live = g && (!g.expiresAt || g.expiresAt > now);
          return {
            environmentId: e.environmentId,
            level: live ? g.level : 'none',
            expiresAt: live ? (g.expiresAt?.toISOString() ?? null) : null,
          };
        }),
      }))
      .sort(
        (a, b) => order[a.principal.type] - order[b.principal.type] || a.name.localeCompare(b.name),
      );

    let pendingProjectWraps: PendingWrap[] = [];
    if (await this.canWrapProjectKey(project, accountId, me.role, now)) {
      const holders = await this.facts.projectKeyHolders(project, now);
      const held = new Set(
        (
          await this.db
            .select({ a: keyGrants.accountId })
            .from(keyGrants)
            .where(and(eq(keyGrants.projectId, projectId), eq(keyGrants.resourceId, projectId)))
        ).map((r) => r.a),
      );
      const org = await this.facts.org(project.orgId, project.ownerId);
      pendingProjectWraps = [...holders]
        .filter((id) => !held.has(id) && org.keys.has(holderKey('account', id)))
        .map((id) => ({
          accountId: id,
          publicKey: org.keys.get(holderKey('account', id)) as PendingWrap['publicKey'],
        }));
    }

    return {
      projectId,
      orgId: project.orgId,
      environments: envs.map((e) => ({
        id: e.environmentId,
        keyVersion: e.keyVersion,
        rotationRequired: e.rotationRequiredAt !== null,
      })),
      rows,
      pendingProjectWraps,
    };
  }

  private async names(principals: PrincipalRef[]): Promise<Map<string, string>> {
    const ids = (t: PrincipalRef['type']) =>
      principals.filter((p) => p.type === t).map((p) => p.id);
    const out = new Map<string, string>();
    const [a, g, ag] = [ids('account'), ids('group'), ids('agent')];
    if (a.length) {
      for (const r of await this.db
        .select({ id: accounts.id, name: accounts.email })
        .from(accounts)
        .where(inArray(accounts.id, a))) {
        out.set(`account:${r.id}`, r.name);
      }
    }
    if (g.length) {
      for (const r of await this.db
        .select({ id: orgGroups.id, name: orgGroups.name })
        .from(orgGroups)
        .where(inArray(orgGroups.id, g))) {
        out.set(`group:${r.id}`, r.name);
      }
    }
    if (ag.length) {
      for (const r of await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, ag))) {
        out.set(`agent:${r.id}`, r.name);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ environments

  /** Loads an environment the caller can see (any active member of its org). */
  private async visible(accountId: string, environmentId: string) {
    const env0 = await this.facts.environment(environmentId);
    const me = await this.facts.member(env0.orgId, accountId);
    const now = this.now();
    await this.facts.reconcileProject(env0.projectId, now);
    return { env: await this.facts.environment(environmentId), me, now };
  }

  async detail(accountId: string, environmentId: string): Promise<EnvironmentAccess> {
    const { env, now } = await this.visible(accountId, environmentId);
    const [grantRows, org] = await Promise.all([
      this.db
        .select()
        .from(environmentGrants)
        .where(eq(environmentGrants.environmentId, environmentId)),
      this.facts.org(env.orgId, env.ownerId),
    ]);
    const myLevel = effectiveLevel({ type: 'account', id: accountId }, grantRows, org, now);
    return {
      environmentId: env.environmentId,
      projectId: env.projectId,
      orgId: env.orgId,
      keyVersion: env.keyVersion,
      rotationRequired: env.rotationRequiredAt !== null,
      myLevel,
      grants: grantRows.map(toGrant),
      pendingWraps: levelAtLeast(myLevel, 'manage') ? await this.pending(env, grantRows, now) : [],
    };
  }

  /** Members with standing access and no grant of the environment key. */
  private async pending(env: Env, grants: GrantFacts[], now: Date): Promise<PendingWrap[]> {
    const org = await this.facts.org(env.orgId, env.ownerId);
    const held = new Set(
      (
        await this.db
          .select({ a: keyGrants.accountId })
          .from(keyGrants)
          .where(
            and(
              eq(keyGrants.projectId, env.projectId),
              eq(keyGrants.resourceId, env.environmentId),
            ),
          )
      ).map((r) => r.a),
    );
    const out: PendingWrap[] = [];
    for (const [key, level] of allLevels(grants, org, now)) {
      if (!key.startsWith('account:') || !holdsKey(level)) continue;
      const id = key.slice('account:'.length);
      const publicKey = org.keys.get(key);
      if (held.has(id) || !publicKey) continue;
      out.push({ accountId: id, publicKey: publicKey as PendingWrap['publicKey'] });
    }
    return out;
  }

  // ------------------------------------------------------------ grants

  /** Managers of the environment, or org owners and admins, can change grants. */
  private async requireGrantManager(accountId: string, environmentId: string) {
    const { env, me, now } = await this.visible(accountId, environmentId);
    if (!ADMIN_ROLES.includes(me.role)) {
      const level = await this.facts.levelOf(env, { type: 'account', id: accountId }, now);
      if (!levelAtLeast(level, 'manage')) {
        throw new ForbiddenException('You cannot manage access here');
      }
    }
    return { env, now };
  }

  private async principalInOrg(orgId: string, p: PrincipalRef): Promise<void> {
    const rows =
      p.type === 'group'
        ? await this.db
            .select({ id: orgGroups.id })
            .from(orgGroups)
            .where(and(eq(orgGroups.id, p.id), eq(orgGroups.orgId, orgId)))
        : p.type === 'agent'
          ? await this.db
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.id, p.id), eq(agents.orgId, orgId)))
          : await this.db
              .select({ id: orgMembers.accountId })
              .from(orgMembers)
              .where(and(eq(orgMembers.accountId, p.id), eq(orgMembers.orgId, orgId)));
    if (rows.length === 0) throw new NotFoundException(`No such ${p.type} in this organization`);
  }

  async putGrant(accountId: string, environmentId: string, req: PutGrantRequest): Promise<Grant> {
    const { env, now } = await this.requireGrantManager(accountId, environmentId);
    await this.principalInOrg(env.orgId, req.principal);
    if (req.principal.type === 'group' && req.level === 'none') {
      throw new UnprocessableEntityException('Remove the group’s grant instead');
    }
    if (req.principal.type === 'agent' && holdsKey(req.level)) {
      throw new UnprocessableEntityException(
        'Agents ask each time: give them Needs approval or No access',
      );
    }
    const expiresAt = req.expiresAt ? new Date(req.expiresAt) : null;
    if (expiresAt && expiresAt <= now) {
      throw new UnprocessableEntityException('The end date must be in the future');
    }
    const row = {
      environmentId,
      principalType: req.principal.type,
      principalId: req.principal.id,
      level: req.level,
      expiresAt,
      grantedBy: accountId,
      createdAt: now,
    };
    await this.db
      .insert(environmentGrants)
      .values(row)
      .onConflictDoUpdate({
        target: [
          environmentGrants.environmentId,
          environmentGrants.principalType,
          environmentGrants.principalId,
        ],
        set: { level: row.level, expiresAt, grantedBy: accountId, createdAt: now },
      });
    await this.facts.reconcileProject(env.projectId, now);
    return toGrant(row);
  }

  async deleteGrant(accountId: string, environmentId: string, principal: PrincipalRef) {
    const { env, now } = await this.requireGrantManager(accountId, environmentId);
    const removed = await this.db
      .delete(environmentGrants)
      .where(
        and(
          eq(environmentGrants.environmentId, environmentId),
          eq(environmentGrants.principalType, principal.type),
          eq(environmentGrants.principalId, principal.id),
        ),
      )
      .returning();
    if (removed.length === 0) throw new NotFoundException();
    await this.facts.reconcileProject(env.projectId, now);
  }

  // ------------------------------------------------------------ keys

  private toStored(
    accountId: string,
    wrappedKey: MemberKeyWrap['blob'],
    box: MemberWrapBox,
  ): StoredMemberWrap {
    return {
      recipientId: accountId,
      recipientPublicKey: box.recipientPublicKey,
      wrapperPublicKey: box.wrapperPublicKey,
      ephemeralPublicKey: box.ephemeralPublicKey,
      blob: wrappedKey,
      keyVersion: box.keyVersion,
      wrappedBy: box.wrappedBy,
    } as StoredMemberWrap;
  }

  /** The caller's member wraps and levels across a project. */
  async myKeys(accountId: string, projectId: string): Promise<MyProjectKeysResponse> {
    const { project, now } = await this.visibleProject(accountId, projectId);
    const { envs, byEnv } = await this.facts.projectLevels(project, now);
    const held = await this.db
      .select()
      .from(keyGrants)
      .where(and(eq(keyGrants.projectId, projectId), eq(keyGrants.accountId, accountId)));
    const wrapOf = (resourceId: string) => {
      const g = held.find((h) => h.resourceId === resourceId);
      return g?.box ? this.toStored(accountId, g.wrappedKey as MemberKeyWrap['blob'], g.box) : null;
    };
    return {
      projectId,
      projectKey: wrapOf(projectId),
      environments: envs.map((e) => ({
        environmentId: e.environmentId,
        keyVersion: e.keyVersion,
        level: byEnv.get(e.environmentId)?.get(holderKey('account', accountId)) ?? 'none',
        wrap: wrapOf(e.environmentId),
      })),
    };
  }

  /** Checks wraps against the keys on file; `allowed` is who may receive this key. */
  private checkWraps(
    wraps: MemberKeyWrap[],
    wrapperKey: string | null,
    keys: Map<string, string>,
    allowed: (accountId: string) => boolean,
  ): void {
    const seen = new Set<string>();
    for (const w of wraps) {
      if (seen.has(w.recipientId)) throw new UnprocessableEntityException('Duplicate recipient');
      seen.add(w.recipientId);
      if (!allowed(w.recipientId)) {
        throw new UnprocessableEntityException(`${w.recipientId} has no access to this key`);
      }
      if (keys.get(holderKey('account', w.recipientId)) !== w.recipientPublicKey) {
        throw new ConflictException(`The key on file for ${w.recipientId} changed; fetch it again`);
      }
      if (w.wrapperPublicKey !== wrapperKey) {
        throw new ConflictException('Your sharing key does not match the one on file');
      }
    }
  }

  private grantRow(
    projectId: string,
    resourceId: string,
    w: MemberKeyWrap,
    keyVersion: number | null,
    wrappedBy: string,
    now: Date,
  ) {
    return {
      projectId,
      resourceId,
      accountId: w.recipientId,
      wrappedKey: w.blob,
      box: {
        recipientPublicKey: w.recipientPublicKey,
        wrapperPublicKey: w.wrapperPublicKey,
        ephemeralPublicKey: w.ephemeralPublicKey,
        keyVersion,
        wrappedBy,
      },
      createdAt: now,
    };
  }

  /** Managers hand the environment's current key to members who don't have it. */
  async addEnvironmentWraps(
    accountId: string,
    environmentId: string,
    req: AddEnvironmentWrapsRequest,
  ): Promise<void> {
    const { env, me, now } = await this.visible(accountId, environmentId);
    const [grants, org] = await Promise.all([
      this.facts.grants(environmentId),
      this.facts.org(env.orgId, env.ownerId),
    ]);
    if (
      !levelAtLeast(effectiveLevel({ type: 'account', id: accountId }, grants, org, now), 'manage')
    ) {
      throw new ForbiddenException('Only managers can hand out the key');
    }
    if (req.keyVersion !== env.keyVersion) {
      throw new ConflictException('The environment key was rotated; wrap the current version');
    }
    const levels = allLevels(grants, org, now);
    this.checkWraps(req.wraps, me.publicKey, org.keys, (id) =>
      holdsKey(levels.get(holderKey('account', id)) ?? 'none'),
    );
    await this.db
      .insert(keyGrants)
      .values(
        req.wraps.map((w) =>
          this.grantRow(env.projectId, environmentId, w, env.keyVersion, accountId, now),
        ),
      )
      .onConflictDoNothing();
  }

  /** Hands the project key (names and other metadata) to members who need it. */
  async addProjectWraps(
    accountId: string,
    projectId: string,
    req: AddProjectWrapsRequest,
  ): Promise<void> {
    const { project, me, now } = await this.visibleProject(accountId, projectId);
    if (!(await this.canWrapProjectKey(project, accountId, me.role, now))) {
      throw new ForbiddenException('You cannot hand out this project’s key');
    }
    const holders = await this.facts.projectKeyHolders(project, now);
    const org = await this.facts.org(project.orgId, project.ownerId);
    this.checkWraps(req.wraps, me.publicKey, org.keys, (id) => holders.has(id));
    await this.db
      .insert(keyGrants)
      .values(req.wraps.map((w) => this.grantRow(projectId, projectId, w, null, accountId, now)))
      .onConflictDoNothing();
  }

  /**
   * Moves an environment to a new key. The manager's device re-sealed every
   * value in it; `wraps` must reach exactly the members who have standing
   * access, so nobody who lost access is handed the new key. Old grants and
   * values are replaced in one transaction.
   */
  async rotate(
    accountId: string,
    environmentId: string,
    req: RotateEnvironmentKeyRequest,
  ): Promise<EnvironmentAccess> {
    const { env, me, now } = await this.visible(accountId, environmentId);
    const [grants, org] = await Promise.all([
      this.facts.grants(environmentId),
      this.facts.org(env.orgId, env.ownerId),
    ]);
    if (
      !levelAtLeast(effectiveLevel({ type: 'account', id: accountId }, grants, org, now), 'manage')
    ) {
      throw new ForbiddenException('Only managers can rotate the key');
    }
    if (req.fromVersion !== env.keyVersion) {
      throw new ConflictException('Someone else rotated this environment first');
    }
    const levels = allLevels(grants, org, now);
    const holders = [...levels.entries()]
      .filter(([k, l]) => k.startsWith('account:') && holdsKey(l) && org.keys.has(k))
      .map(([k]) => k.slice('account:'.length));
    this.checkWraps(req.wraps, me.publicKey, org.keys, (id) => holders.includes(id));
    const missing = holders.filter((id) => !req.wraps.some((w) => w.recipientId === id));
    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `Wrap the new key for everyone with access: ${missing.join(', ')}`,
      );
    }
    if (req.values.some((v) => v.encryptedValue.kid !== environmentId)) {
      throw new UnprocessableEntityException('Values must be sealed with this environment’s key');
    }
    const next = env.keyVersion + 1;
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ seq: projects.seq })
        .from(projects)
        .where(eq(projects.id, env.projectId))
        .for('update');
      const current = await tx
        .select({ secretId: secretValues.secretId })
        .from(secretValues)
        .where(
          and(
            eq(secretValues.projectId, env.projectId),
            eq(secretValues.environmentId, environmentId),
          ),
        );
      const want = new Set(current.map((c) => c.secretId));
      const got = new Set(req.values.map((v) => v.secretId));
      if (
        want.size !== got.size ||
        [...want].some((id) => !got.has(id)) ||
        got.size !== req.values.length
      ) {
        throw new ConflictException(
          'Re-seal exactly the environment’s current values; sync and retry',
        );
      }
      const [bumped] = await tx
        .update(environmentAccess)
        .set({ keyVersion: next, rotationRequiredAt: null })
        .where(
          and(
            eq(environmentAccess.environmentId, environmentId),
            eq(environmentAccess.keyVersion, env.keyVersion),
          ),
        )
        .returning();
      if (!bumped) throw new ConflictException('Someone else rotated this environment first');

      await tx
        .delete(keyGrants)
        .where(
          and(eq(keyGrants.projectId, env.projectId), eq(keyGrants.resourceId, environmentId)),
        );
      await tx
        .insert(keyGrants)
        .values(
          req.wraps.map((w) =>
            this.grantRow(env.projectId, environmentId, w, next, accountId, now),
          ),
        );
      for (const v of req.values) {
        await tx
          .update(secretValues)
          .set({ encryptedValue: v.encryptedValue, updatedAt: now })
          .where(
            and(
              eq(secretValues.projectId, env.projectId),
              eq(secretValues.secretId, v.secretId),
              eq(secretValues.environmentId, environmentId),
            ),
          );
      }
      // Move the environment and its secrets to the end of the change feed so
      // clients pick up the new key and values on their next sync.
      const touched = [environmentId, ...req.values.map((v) => v.secretId)];
      let seq = project!.seq;
      for (const id of touched) {
        seq += 1;
        await tx
          .update(projectEntries)
          .set({ seq, updatedAt: now })
          .where(and(eq(projectEntries.projectId, env.projectId), eq(projectEntries.id, id)));
      }
      await tx.update(projects).set({ seq }).where(eq(projects.id, env.projectId));
    });
    return this.detail(accountId, environmentId);
  }

  // ------------------------------------------------------------ approvals

  private view(r: RequestRow, name: string, forRequester: boolean, now: Date): AccessRequestView {
    const expired = r.status === 'pending' && r.expiresAt <= now;
    const releaseLive =
      forRequester &&
      r.status === 'approved' &&
      r.release &&
      r.releaseExpiresAt &&
      r.releaseExpiresAt > now;
    return {
      id: r.id,
      environmentId: r.environmentId,
      requester: { type: r.requesterType as 'account' | 'agent', id: r.requesterId },
      requesterName: name,
      requesterPublicKey: r.requesterPublicKey as AccessRequestView['requesterPublicKey'],
      items: r.items,
      reason: r.reason,
      status: expired ? 'expired' : r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedBy: r.decidedBy,
      release: releaseLive ? (r.release as AccessRequestView['release']) : null,
    };
  }

  private async nameOf(holder: KeyHolder): Promise<string> {
    return (await this.names([holder])).get(holderKey(holder.type, holder.id)) ?? 'Removed';
  }

  /** A "Needs approval" principal asks for specific secrets, once. */
  async createRequest(
    holder: KeyHolder,
    environmentId: string,
    req: CreateAccessRequest,
  ): Promise<AccessRequestView> {
    const env = await this.facts.environment(environmentId);
    if (holder.type === 'account') await this.facts.member(env.orgId, holder.id);
    const now = this.now();
    const level = await this.facts.levelOf(env, holder, now);
    if (level !== 'needs_approval') {
      throw new ForbiddenException(
        holdsKey(level)
          ? 'You already have access; no approval needed'
          : 'No access to this environment',
      );
    }
    const org = await this.facts.org(env.orgId);
    const publicKey = org.keys.get(holderKey(holder.type, holder.id))!;
    const [row] = await this.db
      .insert(accessRequests)
      .values({
        environmentId,
        requesterType: holder.type,
        requesterId: holder.id,
        requesterPublicKey: publicKey,
        items: req.items,
        reason: req.reason,
        expiresAt: new Date(now.getTime() + ACCESS_LIMITS.requestTtlSeconds * 1000),
        createdAt: now,
      })
      .returning();
    return this.view(row!, await this.nameOf(holder), true, now);
  }

  /** Managers see every open request; others see their own. */
  async listRequests(
    accountId: string,
    environmentId: string,
  ): Promise<ListAccessRequestsResponse> {
    const { env, now } = await this.visible(accountId, environmentId);
    const level = await this.facts.levelOf(env, { type: 'account', id: accountId }, now);
    const manager = levelAtLeast(level, 'manage');
    const rows = await this.db
      .select()
      .from(accessRequests)
      .where(
        manager
          ? and(
              eq(accessRequests.environmentId, environmentId),
              eq(accessRequests.status, 'pending'),
            )
          : and(
              eq(accessRequests.environmentId, environmentId),
              eq(accessRequests.requesterType, 'account'),
              eq(accessRequests.requesterId, accountId),
            ),
      )
      .orderBy(desc(accessRequests.createdAt));
    const names = await this.names(rows.map((r) => ({ type: r.requesterType, id: r.requesterId })));
    return {
      requests: rows
        .map((r) =>
          this.view(
            r,
            names.get(`${r.requesterType}:${r.requesterId}`) ?? 'Removed',
            r.requesterType === 'account' && r.requesterId === accountId,
            now,
          ),
        )
        .filter((v) => !manager || v.status === 'pending'),
    };
  }

  async getRequest(holder: KeyHolder, requestId: string): Promise<AccessRequestView> {
    const [r] = await this.db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
    if (!r) throw new NotFoundException();
    const now = this.now();
    const isRequester = r.requesterType === holder.type && r.requesterId === holder.id;
    if (!isRequester) {
      if (holder.type !== 'account') throw new NotFoundException();
      const env = await this.facts.environment(r.environmentId);
      await this.facts.member(env.orgId, holder.id).catch(() => {
        throw new NotFoundException();
      });
      if (!levelAtLeast(await this.facts.levelOf(env, holder, now), 'manage')) {
        throw new NotFoundException();
      }
    }
    return this.view(
      r,
      await this.nameOf({ type: r.requesterType as KeyHolder['type'], id: r.requesterId }),
      isRequester,
      now,
    );
  }

  private async decidable(accountId: string, requestId: string) {
    const [r] = await this.db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
    if (!r) throw new NotFoundException();
    const { env, me, now } = await this.visible(accountId, r.environmentId);
    if (
      !levelAtLeast(
        await this.facts.levelOf(env, { type: 'account', id: accountId }, now),
        'manage',
      )
    ) {
      throw new ForbiddenException('Only managers can decide requests');
    }
    if (r.status !== 'pending' || r.expiresAt <= now) {
      throw new ConflictException('This request was already decided or has expired');
    }
    return { r, env, me, now };
  }

  /** The approver's device sealed the requested values to the requester. */
  async approve(
    accountId: string,
    requestId: string,
    req: ApproveAccessRequest,
  ): Promise<AccessRequestView> {
    const { r, env, me, now } = await this.decidable(accountId, requestId);
    if (req.approverPublicKey !== me.publicKey) {
      throw new ConflictException('Your sharing key does not match the one on file');
    }
    const requester = { type: r.requesterType as KeyHolder['type'], id: r.requesterId };
    if ((await this.facts.levelOf(env, requester, now)) !== 'needs_approval') {
      throw new ConflictException("The requester's access changed; the request no longer applies");
    }
    const [row] = await this.db
      .update(accessRequests)
      .set({
        status: 'approved',
        decidedBy: accountId,
        decidedAt: now,
        release: req,
        releaseExpiresAt: new Date(now.getTime() + ACCESS_LIMITS.releaseTtlSeconds * 1000),
      })
      .where(and(eq(accessRequests.id, requestId), eq(accessRequests.status, 'pending')))
      .returning();
    if (!row) throw new ConflictException('This request was already decided');
    return this.view(row, await this.nameOf(requester), false, now);
  }

  async deny(accountId: string, requestId: string): Promise<AccessRequestView> {
    const { now } = await this.decidable(accountId, requestId);
    const [row] = await this.db
      .update(accessRequests)
      .set({ status: 'denied', decidedBy: accountId, decidedAt: now })
      .where(and(eq(accessRequests.id, requestId), eq(accessRequests.status, 'pending')))
      .returning();
    if (!row) throw new ConflictException('This request was already decided');
    return this.view(
      row,
      await this.nameOf({ type: row.requesterType as KeyHolder['type'], id: row.requesterId }),
      false,
      now,
    );
  }

  /**
   * For other modules (secrets, agents): the principal's level, or a 403 when
   * it is below `required`.
   */
  async require(
    holder: KeyHolder,
    environmentId: string,
    required: AccessLevel,
  ): Promise<AccessLevel> {
    const env = await this.facts.environment(environmentId);
    const level = await this.facts.levelOf(env, holder, this.now());
    if (!levelAtLeast(level, required)) throw new ForbiddenException();
    return level;
  }
}

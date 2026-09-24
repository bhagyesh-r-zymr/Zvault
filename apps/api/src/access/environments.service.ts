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
  type AddWrapsRequest,
  type ApproveAccessRequest,
  type CreateAccessRequest,
  type EnvironmentAccess,
  type Grant,
  type ListAccessRequestsResponse,
  type MyEnvironmentKeysResponse,
  type PendingWrap,
  type PrincipalRef,
  type ProjectAccessResponse,
  type PutGrantRequest,
  type RegisterEnvironmentRequest,
  type RotateEnvironmentKeyRequest,
  type WrappedEnvironmentKey,
} from '@zvault/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  accessRequests,
  accounts,
  agents,
  environmentAccess,
  environmentGrants,
  environmentKeyWraps,
  orgGroups,
  orgMembers,
} from '../db/schema.js';
import { ADMIN_ROLES, AccessFacts, type EnvironmentRow, type KeyHolder } from './access.facts.js';
import { ACCESS_CLOCK, type Clock } from './clock.js';
import { allLevels, effectiveLevel, holderKey, type GrantFacts } from './levels.js';

type GrantRow = typeof environmentGrants.$inferSelect;
type RequestRow = typeof accessRequests.$inferSelect;

const toGrant = (g: GrantRow): Grant => ({
  principal: { type: g.principalType, id: g.principalId },
  level: g.level,
  expiresAt: g.expiresAt?.toISOString() ?? null,
  grantedBy: g.grantedBy,
  createdAt: g.createdAt.toISOString(),
});

/**
 * Who can reach each environment, and the wrapped copies of its key.
 *
 * The server decides who may *fetch* a wrap, but it never holds an unwrapped
 * key: wraps are made on a manager's device, and when someone loses access the
 * environment is flagged until a manager's device rotates to a new key.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCESS_CLOCK) private readonly now: Clock,
    private readonly facts: AccessFacts,
  ) {}

  // ------------------------------------------------------------ setup

  async register(accountId: string, req: RegisterEnvironmentRequest): Promise<EnvironmentAccess> {
    const me = await this.facts.member(req.orgId, accountId);
    const w = req.wrap;
    if (w.recipient.type !== 'account' || w.recipient.id !== accountId) {
      throw new UnprocessableEntityException('Wrap the first key version to yourself');
    }
    if (w.recipientPublicKey !== me.publicKey || w.wrapperPublicKey !== me.publicKey) {
      throw new ConflictException('Your sharing key does not match the one on file');
    }
    const now = this.now();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(environmentAccess).values({
          environmentId: req.environmentId,
          projectId: req.projectId,
          orgId: req.orgId,
          name: req.name,
          keyVersion: 1,
          createdBy: accountId,
          createdAt: now,
        });
        await tx.insert(environmentGrants).values({
          environmentId: req.environmentId,
          principalType: 'account',
          principalId: accountId,
          level: 'manage',
          grantedBy: accountId,
          createdAt: now,
        });
        await tx
          .insert(environmentKeyWraps)
          .values(this.wrapRow(req.environmentId, 1, w, accountId, now));
      });
    } catch (e) {
      const code =
        (e as { code?: string; cause?: { code?: string } }).code ??
        (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new ConflictException('Environment already registered');
      throw e;
    }
    return this.detail(accountId, req.environmentId);
  }

  private wrapRow(
    environmentId: string,
    keyVersion: number,
    w: WrappedEnvironmentKey,
    wrappedBy: string,
    now: Date,
  ) {
    return {
      environmentId,
      keyVersion,
      principalType: w.recipient.type,
      principalId: w.recipient.id,
      box: {
        recipientPublicKey: w.recipientPublicKey,
        wrapperPublicKey: w.wrapperPublicKey,
        ephemeralPublicKey: w.ephemeralPublicKey,
        blob: w.blob,
      },
      wrappedBy,
      createdAt: now,
    };
  }

  // ------------------------------------------------------------ reading

  /** Loads an environment the caller can see (any member of its org). */
  private async visible(accountId: string, environmentId: string) {
    const env = await this.facts.environment(environmentId);
    const me = await this.facts.member(env.orgId, accountId);
    const now = this.now();
    await this.facts.reconcile([environmentId], now);
    return { env: await this.facts.environment(environmentId), me, now };
  }

  async detail(accountId: string, environmentId: string): Promise<EnvironmentAccess> {
    const { env, now } = await this.visible(accountId, environmentId);
    const [grantRows, org] = await Promise.all([
      this.db
        .select()
        .from(environmentGrants)
        .where(eq(environmentGrants.environmentId, environmentId)),
      this.facts.org(env.orgId),
    ]);
    const myLevel = effectiveLevel({ type: 'account', id: accountId }, grantRows, org, now);
    return {
      environmentId: env.environmentId,
      projectId: env.projectId,
      orgId: env.orgId,
      name: env.name,
      keyVersion: env.keyVersion,
      rotationRequired: env.rotationRequiredAt !== null,
      myLevel,
      grants: grantRows.map(toGrant),
      pendingWraps: levelAtLeast(myLevel, 'manage') ? await this.pending(env, grantRows, now) : [],
    };
  }

  /** Key holders with standing access and no wrap of the current version. */
  private async pending(
    env: EnvironmentRow,
    grants: GrantFacts[],
    now: Date,
  ): Promise<PendingWrap[]> {
    const org = await this.facts.org(env.orgId);
    const wrapped = new Set(
      (
        await this.db
          .select({ t: environmentKeyWraps.principalType, id: environmentKeyWraps.principalId })
          .from(environmentKeyWraps)
          .where(
            and(
              eq(environmentKeyWraps.environmentId, env.environmentId),
              eq(environmentKeyWraps.keyVersion, env.keyVersion),
            ),
          )
      ).map((w) => `${w.t}:${w.id}`),
    );
    const out: PendingWrap[] = [];
    for (const [key, level] of allLevels(grants, org, now)) {
      if (!holdsKey(level) || wrapped.has(key)) continue;
      const [type, id] = key.split(':') as ['account' | 'agent', string];
      out.push({
        recipient: { type, id },
        publicKey: org.keys.get(key) as PendingWrap['publicKey'],
      });
    }
    return out;
  }

  /** The "Project access" matrix: raw grants per principal and environment. */
  async project(accountId: string, projectId: string): Promise<ProjectAccessResponse> {
    const all = await this.db
      .select()
      .from(environmentAccess)
      .where(eq(environmentAccess.projectId, projectId))
      .orderBy(environmentAccess.createdAt);
    const orgIds = [...new Set(all.map((e) => e.orgId))];
    const mine = await this.db
      .select({ orgId: orgMembers.orgId, publicKey: orgMembers.publicKey })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.accountId, accountId),
          inArray(orgMembers.orgId, orgIds.length ? orgIds : [projectId]),
        ),
      );
    const allowed = new Set(mine.filter((m) => m.publicKey).map((m) => m.orgId));
    const envs = all.filter((e) => allowed.has(e.orgId));
    if (envs.length === 0) throw new NotFoundException();
    const now = this.now();
    await this.facts.reconcile(
      envs.map((e) => e.environmentId),
      now,
    );
    const fresh = await this.db
      .select()
      .from(environmentAccess)
      .where(
        inArray(
          environmentAccess.environmentId,
          envs.map((e) => e.environmentId),
        ),
      )
      .orderBy(environmentAccess.createdAt);
    const grants = await this.db
      .select()
      .from(environmentGrants)
      .where(
        inArray(
          environmentGrants.environmentId,
          fresh.map((e) => e.environmentId),
        ),
      );

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
        cells: fresh.map((e) => {
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
    return {
      projectId,
      environments: fresh.map((e) => ({
        id: e.environmentId,
        name: e.name,
        rotationRequired: e.rotationRequiredAt !== null,
      })),
      rows,
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

  // ------------------------------------------------------------ grants

  /** Managers of the environment, or org owners and admins, can change grants. */
  private async requireGrantManager(accountId: string, environmentId: string) {
    const { env, me, now } = await this.visible(accountId, environmentId);
    if (!ADMIN_ROLES.includes(me.role)) {
      const level = await this.facts.levelOf(env, { type: 'account', id: accountId }, now);
      if (!levelAtLeast(level, 'manage'))
        throw new ForbiddenException('You cannot manage access here');
    }
    return { env, now };
  }

  /** Refuses a change that would leave no member able to manage (and wrap) the environment. */
  private async ensureAManagerRemains(env: EnvironmentRow, grants: GrantFacts[], now: Date) {
    const org = await this.facts.org(env.orgId);
    const levels = allLevels(grants, org, now);
    const managers = [...levels.entries()].filter(
      ([key, level]) => key.startsWith('account:') && level === 'manage',
    );
    if (managers.length === 0) {
      throw new ConflictException('At least one member must keep Manage access');
    }
  }

  private async principalInOrg(orgId: string, p: PrincipalRef): Promise<void> {
    const table =
      p.type === 'group'
        ? this.db
            .select({ id: orgGroups.id })
            .from(orgGroups)
            .where(and(eq(orgGroups.id, p.id), eq(orgGroups.orgId, orgId)))
        : p.type === 'agent'
          ? this.db
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.id, p.id), eq(agents.orgId, orgId)))
          : this.db
              .select({ id: orgMembers.accountId })
              .from(orgMembers)
              .where(and(eq(orgMembers.accountId, p.id), eq(orgMembers.orgId, orgId)));
    if ((await table).length === 0)
      throw new NotFoundException(`No such ${p.type} in this organization`);
  }

  async putGrant(accountId: string, environmentId: string, req: PutGrantRequest): Promise<Grant> {
    const { env, now } = await this.requireGrantManager(accountId, environmentId);
    await this.principalInOrg(env.orgId, req.principal);
    if (req.principal.type === 'group' && req.level === 'none') {
      throw new UnprocessableEntityException('Remove the group’s grant instead');
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
    const others = (await this.facts.grants(environmentId)).filter(
      (g) => !(g.principalType === row.principalType && g.principalId === row.principalId),
    );
    await this.ensureAManagerRemains(env, [...others, row], now);
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
    await this.facts.reconcile([environmentId], now);
    return toGrant(row);
  }

  async deleteGrant(accountId: string, environmentId: string, principal: PrincipalRef) {
    const { env, now } = await this.requireGrantManager(accountId, environmentId);
    const grants = await this.facts.grants(environmentId);
    const rest = grants.filter(
      (g) => !(g.principalType === principal.type && g.principalId === principal.id),
    );
    if (rest.length === grants.length) throw new NotFoundException();
    await this.ensureAManagerRemains(env, rest, now);
    await this.db
      .delete(environmentGrants)
      .where(
        and(
          eq(environmentGrants.environmentId, environmentId),
          eq(environmentGrants.principalType, principal.type),
          eq(environmentGrants.principalId, principal.id),
        ),
      );
    await this.facts.reconcile([environmentId], now);
  }

  // ------------------------------------------------------------ keys

  /** A key holder's wraps, only while they have standing access. */
  async myKeys(holder: KeyHolder, environmentId: string): Promise<MyEnvironmentKeysResponse> {
    const env0 = await this.facts.environment(environmentId);
    if (holder.type === 'account') await this.facts.member(env0.orgId, holder.id);
    const now = this.now();
    await this.facts.reconcile([environmentId], now);
    const env = await this.facts.environment(environmentId);
    const level = await this.facts.levelOf(env, holder, now);
    if (!holdsKey(level)) throw new ForbiddenException('No standing access to this environment');
    const rows = await this.db
      .select()
      .from(environmentKeyWraps)
      .where(
        and(
          eq(environmentKeyWraps.environmentId, environmentId),
          eq(environmentKeyWraps.principalType, holder.type),
          eq(environmentKeyWraps.principalId, holder.id),
        ),
      )
      .orderBy(desc(environmentKeyWraps.keyVersion));
    return {
      environmentId,
      keyVersion: env.keyVersion,
      wraps: rows.map((r) => ({
        recipient: { type: holder.type, id: holder.id },
        ...r.box,
        keyVersion: r.keyVersion,
        wrappedBy: r.wrappedBy,
        createdAt: r.createdAt.toISOString(),
      })) as MyEnvironmentKeysResponse['wraps'],
    };
  }

  /** Checks wraps from a manager against the keys on file and current access. */
  private async checkWraps(
    env: EnvironmentRow,
    accountId: string,
    wraps: WrappedEnvironmentKey[],
    now: Date,
  ) {
    const me = await this.facts.member(env.orgId, accountId);
    const [grants, org] = await Promise.all([
      this.facts.grants(env.environmentId),
      this.facts.org(env.orgId),
    ]);
    if (
      !levelAtLeast(effectiveLevel({ type: 'account', id: accountId }, grants, org, now), 'manage')
    ) {
      throw new ForbiddenException('Only managers can hand out the key');
    }
    const levels = allLevels(grants, org, now);
    const seen = new Set<string>();
    for (const w of wraps) {
      const key = holderKey(w.recipient.type, w.recipient.id);
      if (seen.has(key)) throw new UnprocessableEntityException('Duplicate recipient');
      seen.add(key);
      if (!holdsKey(levels.get(key) ?? 'none')) {
        throw new UnprocessableEntityException(`${key} has no standing access`);
      }
      if (org.keys.get(key) !== w.recipientPublicKey) {
        throw new ConflictException(`The key on file for ${key} changed; fetch it again`);
      }
      if (w.wrapperPublicKey !== me.publicKey) {
        throw new ConflictException('Your sharing key does not match the one on file');
      }
    }
    return { levels, seen };
  }

  async addWraps(accountId: string, environmentId: string, req: AddWrapsRequest): Promise<void> {
    const { env, now } = await this.visible(accountId, environmentId);
    if (req.keyVersion !== env.keyVersion) {
      throw new ConflictException('The environment key was rotated; wrap the current version');
    }
    await this.checkWraps(env, accountId, req.wraps, now);
    await this.db
      .insert(environmentKeyWraps)
      .values(req.wraps.map((w) => this.wrapRow(environmentId, env.keyVersion, w, accountId, now)))
      .onConflictDoNothing();
  }

  /**
   * Moves to the next key version. The manager's device has already re-sealed
   * the environment's secrets; `wraps` must reach exactly the current key
   * holders, so nobody who lost access is handed the new key.
   */
  async rotate(
    accountId: string,
    environmentId: string,
    req: RotateEnvironmentKeyRequest,
  ): Promise<EnvironmentAccess> {
    const { env, now } = await this.visible(accountId, environmentId);
    if (req.fromVersion !== env.keyVersion) {
      throw new ConflictException('Someone else rotated this environment first');
    }
    const { levels, seen } = await this.checkWraps(env, accountId, req.wraps, now);
    const missing = [...levels.entries()].filter(([k, l]) => holdsKey(l) && !seen.has(k));
    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `Wrap the new key for everyone with access: ${missing.map(([k]) => k).join(', ')}`,
      );
    }
    const next = env.keyVersion + 1;
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(environmentAccess)
        .set({ keyVersion: next, rotationRequiredAt: null })
        .where(
          and(
            eq(environmentAccess.environmentId, environmentId),
            eq(environmentAccess.keyVersion, env.keyVersion),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException('Someone else rotated this environment first');
      await tx
        .insert(environmentKeyWraps)
        .values(req.wraps.map((w) => this.wrapRow(environmentId, next, w, accountId, now)));
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

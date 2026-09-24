import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ACCESS_LIMITS,
  type AcceptInviteRequest,
  type CreateGroupRequest,
  type CreateOrgRequest,
  type InviteMemberRequest,
  type ListOrgsResponse,
  type OrgAgent,
  type OrgDetail,
  type OrgGroup,
  type OrgMember,
  type OrgRole,
  type RegisterAgentRequest,
} from '@zvault/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import {
  accounts,
  agents,
  groupMembers,
  orgGroups,
  orgMembers,
  organizations,
} from '../db/schema.js';
import { Mailer } from '../mail/mailer.js';
import { orgInviteEmail } from '../mail/templates.js';
import { ACCESS_CLOCK, type Clock } from './clock.js';
import { ADMIN_ROLES, AccessFacts } from './access.facts.js';

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } }).code === '23505' ||
  (e as { cause?: { code?: string } }).cause?.code === '23505';

/** Organizations, their members, groups and agents. */
@Injectable()
export class OrgsService {
  private readonly logger = new Logger('OrgsService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCESS_CLOCK) private readonly now: Clock,
    private readonly facts: AccessFacts,
    private readonly mailer: Mailer,
  ) {}

  private async requireAdmin(orgId: string, accountId: string) {
    const me = await this.facts.member(orgId, accountId);
    if (!ADMIN_ROLES.includes(me.role))
      throw new ForbiddenException('Only owners and admins can do that');
    return me;
  }

  async create(accountId: string, req: CreateOrgRequest): Promise<OrgDetail> {
    const now = this.now();
    const orgId = await this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: req.name, createdBy: accountId, createdAt: now })
        .returning({ id: organizations.id });
      await tx.insert(orgMembers).values({
        orgId: org!.id,
        accountId,
        role: 'owner',
        publicKey: req.publicKey,
        joinedAt: now,
        createdAt: now,
      });
      return org!.id;
    });
    return this.detail(orgId, accountId);
  }

  async list(accountId: string): Promise<ListOrgsResponse> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        role: orgMembers.role,
        publicKey: orgMembers.publicKey,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.accountId, accountId))
      .orderBy(organizations.name);
    return {
      orgs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        status: r.publicKey ? 'active' : 'invited',
      })),
    };
  }

  async detail(orgId: string, accountId: string): Promise<OrgDetail> {
    const me = await this.facts.member(orgId, accountId);
    const [[org], memberRows, groupRows, membershipRows, agentRows] = await Promise.all([
      this.db.select().from(organizations).where(eq(organizations.id, orgId)),
      this.db
        .select({
          accountId: orgMembers.accountId,
          email: accounts.email,
          role: orgMembers.role,
          publicKey: orgMembers.publicKey,
        })
        .from(orgMembers)
        .innerJoin(accounts, eq(accounts.id, orgMembers.accountId))
        .where(eq(orgMembers.orgId, orgId))
        .orderBy(accounts.email),
      this.db.select().from(orgGroups).where(eq(orgGroups.orgId, orgId)).orderBy(orgGroups.name),
      this.db
        .select({ groupId: groupMembers.groupId, accountId: groupMembers.accountId })
        .from(groupMembers)
        .innerJoin(orgGroups, eq(orgGroups.id, groupMembers.groupId))
        .where(eq(orgGroups.orgId, orgId)),
      this.db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(agents.name),
    ]);
    const members: OrgMember[] = memberRows.map((m) => ({
      accountId: m.accountId,
      email: m.email,
      role: m.role,
      status: m.publicKey ? 'active' : 'invited',
      publicKey: m.publicKey as OrgMember['publicKey'],
      groupIds: membershipRows.filter((g) => g.accountId === m.accountId).map((g) => g.groupId),
    }));
    const groups: OrgGroup[] = groupRows.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: membershipRows.filter((m) => m.groupId === g.id).map((m) => m.accountId),
    }));
    return {
      id: org!.id,
      name: org!.name,
      role: me.role,
      members,
      groups,
      agents: agentRows.map((a) => this.toAgent(a)),
    };
  }

  // ------------------------------------------------------------ members

  async invite(orgId: string, accountId: string, req: InviteMemberRequest): Promise<OrgMember> {
    const me = await this.requireAdmin(orgId, accountId);
    if (req.role === 'admin' && me.role !== 'owner') {
      throw new ForbiddenException('Only owners can invite admins');
    }
    const [invitee] = await this.db
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(eq(accounts.email, req.email.trim().toLowerCase()));
    if (!invitee) throw new NotFoundException('No Zvault account uses that email yet');
    try {
      await this.db.insert(orgMembers).values({
        orgId,
        accountId: invitee.id,
        role: req.role,
        invitedBy: accountId,
        createdAt: this.now(),
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Already a member or invited');
      throw e;
    }
    await this.sendInvite(orgId, accountId, invitee.email);
    return {
      accountId: invitee.id,
      email: invitee.email,
      role: req.role,
      status: 'invited',
      publicKey: null,
      groupIds: [],
    };
  }

  /** Emails the invitee. The invite is already saved, so a failed email is only logged. */
  private async sendInvite(orgId: string, inviterId: string, to: string): Promise<void> {
    try {
      const [org] = await this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const [inviter] = await this.db
        .select({ email: accounts.email })
        .from(accounts)
        .where(eq(accounts.id, inviterId));
      if (!org || !inviter) return;
      await this.mailer.send(orgInviteEmail(to, org.name, inviter.email));
    } catch (err) {
      this.logger.error(`Could not email an invite to org ${orgId}: ${String(err)}`);
    }
  }

  /** The invitee accepts and publishes the key environment keys will be wrapped to. */
  async accept(orgId: string, accountId: string, req: AcceptInviteRequest): Promise<OrgDetail> {
    const me = await this.facts.member(orgId, accountId, { active: false });
    if (me.publicKey) throw new ConflictException('Already a member');
    await this.db
      .update(orgMembers)
      .set({ publicKey: req.publicKey, joinedAt: this.now() })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.accountId, accountId)));
    return this.detail(orgId, accountId);
  }

  private async ownerCount(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
    return row?.n ?? 0;
  }

  async changeRole(orgId: string, accountId: string, targetId: string, role: OrgRole) {
    const me = await this.requireAdmin(orgId, accountId);
    const target = await this.facts.member(orgId, targetId, { active: false });
    const touchesOwner = role === 'owner' || target.role === 'owner';
    const touchesAdmin = role === 'admin' || target.role === 'admin';
    if ((touchesOwner || touchesAdmin) && me.role !== 'owner') {
      throw new ForbiddenException('Only owners can change owners and admins');
    }
    if (target.role === 'owner' && role !== 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw new ConflictException('An organization needs at least one owner');
    }
    await this.db
      .update(orgMembers)
      .set({ role })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.accountId, targetId)));
  }

  /**
   * Removes a member (or lets one leave). Their group memberships, direct
   * grants, agents and key wraps go with them, and every environment they
   * held a key to is flagged for rotation.
   */
  async remove(orgId: string, accountId: string, targetId: string): Promise<void> {
    const leaving = accountId === targetId;
    const me = await this.facts.member(orgId, accountId, { active: !leaving });
    const target = leaving ? me : await this.facts.member(orgId, targetId, { active: false });
    if (!leaving) {
      if (!ADMIN_ROLES.includes(me.role)) throw new ForbiddenException();
      if (target.role !== 'member' && me.role !== 'owner') {
        throw new ForbiddenException('Only owners can remove owners and admins');
      }
    }
    if (target.role === 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw new ConflictException('An organization needs at least one owner');
    }
    const ownedAgents = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.ownerId, targetId)));
    await this.db.transaction(async (tx) => {
      const orgGroupIds = tx
        .select({ id: orgGroups.id })
        .from(orgGroups)
        .where(eq(orgGroups.orgId, orgId));
      await tx
        .delete(groupMembers)
        .where(
          and(eq(groupMembers.accountId, targetId), inArray(groupMembers.groupId, orgGroupIds)),
        );
      await tx.delete(agents).where(and(eq(agents.orgId, orgId), eq(agents.ownerId, targetId)));
      await tx
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.accountId, targetId)));
    });
    await this.facts.dropGrantsTo('account', [targetId], orgId);
    await this.facts.dropGrantsTo(
      'agent',
      ownedAgents.map((a) => a.id),
      orgId,
    );
    await this.facts.reconcileOrg(orgId, this.now());
  }

  // ------------------------------------------------------------ groups

  async createGroup(orgId: string, accountId: string, req: CreateGroupRequest): Promise<OrgGroup> {
    await this.requireAdmin(orgId, accountId);
    const [existing] = await this.db
      .select({ n: count() })
      .from(orgGroups)
      .where(eq(orgGroups.orgId, orgId));
    if ((existing?.n ?? 0) >= ACCESS_LIMITS.groupsPerOrg) {
      throw new UnprocessableEntityException('Too many groups');
    }
    try {
      const [g] = await this.db
        .insert(orgGroups)
        .values({ orgId, name: req.name, createdAt: this.now() })
        .returning();
      return { id: g!.id, name: g!.name, memberIds: [] };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A group with that name exists');
      throw e;
    }
  }

  private async group(orgId: string, groupId: string) {
    const [g] = await this.db
      .select()
      .from(orgGroups)
      .where(and(eq(orgGroups.id, groupId), eq(orgGroups.orgId, orgId)));
    if (!g) throw new NotFoundException();
    return g;
  }

  async deleteGroup(orgId: string, accountId: string, groupId: string): Promise<void> {
    await this.requireAdmin(orgId, accountId);
    await this.group(orgId, groupId);
    await this.facts.dropGrantsTo('group', [groupId], orgId);
    await this.db.delete(orgGroups).where(eq(orgGroups.id, groupId));
    await this.facts.reconcileOrg(orgId, this.now());
  }

  async addToGroup(orgId: string, accountId: string, groupId: string, targetId: string) {
    await this.requireAdmin(orgId, accountId);
    await this.group(orgId, groupId);
    await this.facts.member(orgId, targetId, { active: false });
    await this.db
      .insert(groupMembers)
      .values({ groupId, accountId: targetId, createdAt: this.now() })
      .onConflictDoNothing();
  }

  async removeFromGroup(orgId: string, accountId: string, groupId: string, targetId: string) {
    await this.requireAdmin(orgId, accountId);
    await this.group(orgId, groupId);
    const removed = await this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, targetId)))
      .returning();
    if (removed.length === 0) throw new NotFoundException();
    await this.facts.reconcileOrg(orgId, this.now());
  }

  // ------------------------------------------------------------ agents

  private toAgent(a: typeof agents.$inferSelect): OrgAgent {
    return {
      id: a.id,
      name: a.name,
      ownerId: a.ownerId,
      publicKey: a.publicKey as OrgAgent['publicKey'],
      createdAt: a.createdAt.toISOString(),
    };
  }

  /** Pairs an agent (e.g. Claude Code on this member's Mac) as a principal. */
  async registerAgent(
    orgId: string,
    accountId: string,
    req: RegisterAgentRequest,
  ): Promise<OrgAgent> {
    await this.facts.member(orgId, accountId);
    const [existing] = await this.db
      .select({ n: count() })
      .from(agents)
      .where(eq(agents.orgId, orgId));
    if ((existing?.n ?? 0) >= ACCESS_LIMITS.agentsPerOrg) {
      throw new UnprocessableEntityException('Too many agents');
    }
    const [a] = await this.db
      .insert(agents)
      .values({
        orgId,
        ownerId: accountId,
        name: req.name,
        publicKey: req.publicKey,
        createdAt: this.now(),
      })
      .returning();
    return this.toAgent(a!);
  }

  async removeAgent(orgId: string, accountId: string, agentId: string): Promise<void> {
    const me = await this.facts.member(orgId, accountId);
    const [a] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    if (!a) throw new NotFoundException();
    if (a.ownerId !== accountId && !ADMIN_ROLES.includes(me.role)) throw new ForbiddenException();
    await this.db.delete(agents).where(eq(agents.id, agentId));
    await this.facts.dropGrantsTo('agent', [agentId], orgId);
    await this.facts.reconcileOrg(orgId, this.now());
  }
}

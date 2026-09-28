import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  MAX_TOKEN_DAYS,
  MAX_TOKENS_PER_PROJECT,
  type CreateTokenRequest,
  type TokenChangesResponse,
  type TokenSessionResponse,
  type TokenView,
} from '@zvault/shared';
import { and, asc, count, eq, inArray, lt } from 'drizzle-orm';
import { ProjectPolicy } from '../access/project-policy.js';
import { DATABASE, type Database } from '../db/database.js';
import {
  accounts,
  agentTokens,
  environmentAccess,
  projectEntries,
  projects,
  type StoredTokenEnvironment,
} from '../db/schema.js';
import { ProjectsStore } from '../projects/projects.store.js';
import type { AuthenticatedUser } from '../vault/current-user.js';
import { TokenActivity } from './token-activity.js';

type TokenRow = typeof agentTokens.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per token. */
const LAST_USED_GRANULARITY_MS = 60 * 1000;

/** A token that passed every check, for the routes it may call. */
export interface ActiveToken {
  row: TokenRow;
  ownerId: string;
}

/**
 * Read-only access tokens for cloud agents and CI. See
 * `packages/shared/src/tokens.ts` for the key scheme; here the server checks
 * the verifier, the expiry, the creator's access and the key versions, and
 * relays ciphertext.
 */
@Injectable()
export class TokensService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly store: ProjectsStore,
    private readonly policy: ProjectPolicy,
    private readonly activity: TokenActivity,
  ) {}

  // ------------------------------------------------------------ management

  async create(
    user: AuthenticatedUser,
    projectId: string,
    req: CreateTokenRequest,
  ): Promise<TokenView> {
    const access = await this.memberAccess(user, projectId);
    const envIds = req.environments.map((e) => e.environmentId);
    if (new Set(envIds).size !== envIds.length) {
      throw new BadRequestException({ error: 'duplicate_id' });
    }
    // The creator must hold every key they wrap, and manage the environment.
    if (!envIds.every((id) => access.environments.has(id))) {
      throw new ForbiddenException({ error: 'no_access' });
    }
    if (!(await this.policy.canManageTokens(projectId, user.id, access.ownerId, envIds[0]!))) {
      throw new ForbiddenException({ error: 'manage_required' });
    }
    const versions = await this.keyVersions(projectId, envIds);
    if (req.environments.some((e) => versions.get(e.environmentId) !== e.keyVersion)) {
      throw new ConflictException({ error: 'key_version_changed' });
    }
    const now = new Date();
    const expiresAt = new Date(req.expiresAt);
    if (
      expiresAt <= now ||
      expiresAt.getTime() - now.getTime() > MAX_TOKEN_DAYS * DAY_MS + DAY_MS
    ) {
      throw new BadRequestException({ error: 'invalid_expiry' });
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(agentTokens)
      .where(eq(agentTokens.projectId, projectId));
    if (n >= MAX_TOKENS_PER_PROJECT) throw new BadRequestException({ error: 'limit_reached' });

    const inserted = await this.db
      .insert(agentTokens)
      .values({
        id: req.id,
        projectId,
        createdBy: user.id,
        name: req.name,
        verifier: Buffer.from(req.verifier, 'base64url'),
        encryptedProjectKey: req.encryptedProjectKey,
        environments: req.environments,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: agentTokens.id });
    if (inserted.length === 0) throw new ConflictException({ error: 'token_exists' });
    await this.activity.record({
      kind: 'issued',
      tokenId: req.id,
      projectId,
      accountId: user.id,
      name: req.name,
    });
    const view = (await this.list(user, projectId)).find((t) => t.id === req.id);
    if (!view) throw new NotFoundException();
    return view;
  }

  /** Tokens of environments the caller manages. Expired tokens are dropped here. */
  async list(user: AuthenticatedUser, projectId: string): Promise<TokenView[]> {
    const access = await this.memberAccess(user, projectId);
    await this.db
      .delete(agentTokens)
      .where(and(eq(agentTokens.projectId, projectId), lt(agentTokens.expiresAt, new Date())));
    const rows = await this.db
      .select({ token: agentTokens, email: accounts.email })
      .from(agentTokens)
      .innerJoin(accounts, eq(accounts.id, agentTokens.createdBy))
      .where(eq(agentTokens.projectId, projectId))
      .orderBy(asc(agentTokens.createdAt));
    const versions = await this.keyVersions(
      projectId,
      rows.flatMap((r) => r.token.environments.map((e) => e.environmentId)),
    );
    const manages = new Map<string, boolean>();
    const out: TokenView[] = [];
    for (const { token, email } of rows) {
      const primary = token.environments[0]!.environmentId;
      if (!manages.has(primary)) {
        manages.set(
          primary,
          await this.policy.canManageTokens(projectId, user.id, access.ownerId, primary),
        );
      }
      if (!manages.get(primary)) continue;
      out.push({
        id: token.id,
        name: token.name,
        environmentIds: token.environments.map((e) => e.environmentId),
        createdBy: { id: token.createdBy, email },
        createdAt: token.createdAt.toISOString(),
        expiresAt: token.expiresAt.toISOString(),
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        stale: isStale(token.environments, versions),
      });
    }
    return out;
  }

  async revoke(user: AuthenticatedUser, projectId: string, tokenId: string): Promise<void> {
    const access = await this.memberAccess(user, projectId);
    const [token] = await this.db
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.projectId, projectId)));
    if (!token) throw new NotFoundException();
    const primary = token.environments[0]!.environmentId;
    const mayRevoke =
      token.createdBy === user.id ||
      (await this.policy.canManageTokens(projectId, user.id, access.ownerId, primary));
    if (!mayRevoke) throw new NotFoundException();
    await this.db.delete(agentTokens).where(eq(agentTokens.id, tokenId));
    await this.activity.record({ kind: 'revoked', tokenId, projectId, accountId: user.id });
  }

  // ------------------------------------------------------------ token use

  /**
   * Checks a presented token: the verifier (in constant time), the expiry,
   * that its creator still holds every key it carries, and that no key was
   * rotated since. Unknown and wrong tokens are indistinguishable.
   */
  async authenticate(tokenId: string, authKey: string): Promise<ActiveToken> {
    const [row] = await this.db.select().from(agentTokens).where(eq(agentTokens.id, tokenId));
    const presented = createHash('sha256').update(Buffer.from(authKey, 'base64url')).digest();
    const expected = row?.verifier ?? Buffer.alloc(32);
    if (!row || expected.length !== 32 || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException({ error: 'invalid_token' });
    }
    const deny = async (
      reason: 'expired' | 'stale' | 'creator_lost_access' | 'environment_deleted',
    ): Promise<never> => {
      await this.activity.record({ kind: 'denied', tokenId, projectId: row.projectId, reason });
      if (reason === 'stale') throw new ConflictException({ error: 'token_stale' });
      throw new UnauthorizedException({ error: `token_${reason}` });
    };

    const now = new Date();
    if (row.expiresAt <= now) return deny('expired');

    const envIds = row.environments.map((e) => e.environmentId);
    const live = await this.db
      .select({ id: projectEntries.id })
      .from(projectEntries)
      .where(
        and(
          eq(projectEntries.projectId, row.projectId),
          inArray(projectEntries.id, envIds),
          eq(projectEntries.type, 'environment'),
          eq(projectEntries.deleted, false),
        ),
      );
    if (live.length !== envIds.length) return deny('environment_deleted');

    // Lapsed grants (removals, end dates) are dropped before checking.
    await this.policy.beforeAccess(row.projectId);
    const access = await this.store.getAccess(row.projectId, row.createdBy);
    if (!access?.member || !envIds.every((id) => access.environments.has(id))) {
      return deny('creator_lost_access');
    }
    if (isStale(row.environments, await this.keyVersions(row.projectId, envIds))) {
      return deny('stale');
    }

    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
      await this.db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, tokenId));
    }
    return { row, ownerId: access.ownerId };
  }

  async session({ row }: ActiveToken): Promise<TokenSessionResponse> {
    const [project] = await this.db
      .select({ encryptedMeta: projects.encryptedMeta })
      .from(projects)
      .where(eq(projects.id, row.projectId));
    if (!project) throw new UnauthorizedException({ error: 'invalid_token' });
    await this.activity.record({
      kind: 'used',
      tokenId: row.id,
      projectId: row.projectId,
      environmentIds: row.environments.map((e) => e.environmentId),
    });
    return {
      token: { id: row.id, name: row.name, expiresAt: row.expiresAt.toISOString() },
      project: {
        id: row.projectId,
        encryptedMeta: project.encryptedMeta,
        encryptedKey: row.encryptedProjectKey,
      },
      environments: row.environments,
    };
  }

  async changes({ row }: ActiveToken, since: number, limit: number): Promise<TokenChangesResponse> {
    const envIds = row.environments.map((e) => e.environmentId);
    // Fetch one extra to learn whether another page follows.
    const changes = await this.store.listChangesForToken(row.projectId, envIds, since, limit + 1);
    const entries = changes.slice(0, limit);
    return { entries, cursor: entries.at(-1)?.seq ?? since, hasMore: changes.length > limit };
  }

  // ------------------------------------------------------------ helpers

  /** Non-members get 404, so project ids can't be probed. */
  private async memberAccess(user: AuthenticatedUser, projectId: string) {
    await this.policy.beforeAccess(projectId);
    const access = await this.store.getAccess(projectId, user.id);
    if (!access?.member) throw new NotFoundException();
    return access;
  }

  /** Current key version of each environment: 1 until an org rotation bumps it. */
  private async keyVersions(
    projectId: string,
    environmentIds: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map(environmentIds.map((id) => [id, 1]));
    if (environmentIds.length === 0) return out;
    const rows = await this.db
      .select({ id: environmentAccess.environmentId, version: environmentAccess.keyVersion })
      .from(environmentAccess)
      .where(
        and(
          eq(environmentAccess.projectId, projectId),
          inArray(environmentAccess.environmentId, [...new Set(environmentIds)]),
        ),
      );
    for (const r of rows) out.set(r.id, r.version);
    return out;
  }
}

function isStale(envs: readonly StoredTokenEnvironment[], current: ReadonlyMap<string, number>) {
  return envs.some((e) => (current.get(e.environmentId) ?? 1) !== e.keyVersion);
}

import { type AccessLevel, type PrincipalType, strongerLevel } from '@zvault/shared';

/** A grant as the resolver needs it. */
export interface GrantFacts {
  principalType: PrincipalType;
  principalId: string;
  level: AccessLevel;
  expiresAt: Date | null;
}

/** Everyone in an org who could hold an environment key. */
export interface OrgFacts {
  /** The project's owner, who always has Manage on its environments. */
  projectOwnerId?: string | undefined;
  /** Active members (accepted, key published). */
  activeMembers: ReadonlySet<string>;
  /** accountId -> group ids. */
  groupsOf: ReadonlyMap<string, readonly string[]>;
  agents: ReadonlySet<string>;
}

export const holderKey = (type: 'account' | 'agent', id: string) => `${type}:${id}`;

const live = (g: GrantFacts, now: Date) => !g.expiresAt || g.expiresAt > now;

/**
 * A principal's effective level in one environment.
 *
 * - A direct grant to the member or agent, while unexpired, is authoritative:
 *   it can raise *or* lower what their groups give (`none` blocks).
 * - Otherwise a member gets the strongest level among their groups' grants.
 * - Invited (not yet active) members and unknown agents get `none`.
 * - The project's owner always has `manage`, so a project can't be locked out.
 * - Agents never hold keys: anything above `needs_approval` counts as that.
 */
export function effectiveLevel(
  holder: { type: 'account' | 'agent'; id: string },
  grants: readonly GrantFacts[],
  org: OrgFacts,
  now: Date,
): AccessLevel {
  if (holder.type === 'account' && holder.id === org.projectOwnerId) return 'manage';
  if (holder.type === 'account' && !org.activeMembers.has(holder.id)) return 'none';
  if (holder.type === 'agent' && !org.agents.has(holder.id)) return 'none';

  const active = grants.filter((g) => live(g, now));
  const direct = active.find((g) => g.principalType === holder.type && g.principalId === holder.id);
  if (holder.type === 'agent') return direct && direct.level !== 'none' ? 'needs_approval' : 'none';
  if (direct) return direct.level;

  const groups = new Set(org.groupsOf.get(holder.id) ?? []);
  return active
    .filter((g) => g.principalType === 'group' && groups.has(g.principalId))
    .reduce<AccessLevel>((best, g) => strongerLevel(best, g.level), 'none');
}

/** Effective levels for every member and agent of the org, keyed by `holderKey`. */
export function allLevels(
  grants: readonly GrantFacts[],
  org: OrgFacts,
  now: Date,
): Map<string, AccessLevel> {
  const out = new Map<string, AccessLevel>();
  const accounts = new Set(org.activeMembers);
  if (org.projectOwnerId) accounts.add(org.projectOwnerId);
  for (const id of accounts) {
    out.set(holderKey('account', id), effectiveLevel({ type: 'account', id }, grants, org, now));
  }
  for (const id of org.agents) {
    out.set(holderKey('agent', id), effectiveLevel({ type: 'agent', id }, grants, org, now));
  }
  return out;
}

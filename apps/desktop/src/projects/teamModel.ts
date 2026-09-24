import {
  holdsKey,
  parseSecretPath,
  strongerLevel,
  type AccessLevel,
  type EncryptedBlob,
  type EnvironmentAccess,
  type OrgDetail,
  type OrgRole,
  type PendingWrap,
  type PrincipalRef,
  type PrincipalType,
  type ProjectAccessResponse,
} from '@zvault/shared';
import type { ReleaseItem } from './core.js';
import { valueSource, type Project, type ProjectSecret } from './model.js';

/**
 * Pure mapping from the team access API to what the Access screen and the
 * "Who can use" panel show. No I/O; see team.ts for the store.
 */

export const LEVEL_LABELS: Record<AccessLevel, string> = {
  manage: 'Manage',
  edit: 'Edit',
  use: 'Use',
  needs_approval: 'Needs approval',
  none: 'No access',
};

export const LEVEL_TEXT: { level: AccessLevel; text: string }[] = [
  { level: 'manage', text: 'Everything in Edit, plus who has access' },
  { level: 'edit', text: 'Add, change, rotate and share secrets' },
  { level: 'use', text: "Copy, fill and zv run; can't change or share" },
  { level: 'needs_approval', text: 'Each use waits for a manager to approve' },
];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** The `data-level` the access styles key on. */
export const levelAttr = (level: AccessLevel): string =>
  level === 'needs_approval' ? 'approval' : level;

/**
 * Levels a grant can set for each kind of principal, as the API accepts them:
 * groups can't be given "No access" (remove their grant instead) and agents
 * only ever ask each time.
 */
export function levelChoices(type: PrincipalType): AccessLevel[] {
  if (type === 'agent') return ['needs_approval', 'none'];
  if (type === 'group') return ['manage', 'edit', 'use', 'needs_approval'];
  return ['manage', 'edit', 'use', 'needs_approval', 'none'];
}

export const principalKey = (p: PrincipalRef): string => `${p.type}:${p.id}`;

export interface MatrixCell {
  environmentId: string;
  /** The live level of this principal's own grant; `none` when it has none. */
  level: AccessLevel;
  /** Whether a grant row exists (a direct "No access" blocks group access). */
  granted: boolean;
  expiresAt: string | null;
}

export interface MatrixRow {
  key: string;
  principal: PrincipalRef;
  name: string;
  detail: string;
  /** This row is the signed-in account. */
  you: boolean;
  cells: MatrixCell[];
}

/** "Oct 31" style; shown for end dates. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function detailOf(
  p: PrincipalRef,
  org: OrgDetail | null,
  cells: MatrixCell[],
  day: (iso: string) => string,
): string {
  if (p.type === 'group') {
    const n = org?.groups.find((g) => g.id === p.id)?.memberIds.length;
    return n === undefined ? 'Group' : `Group · ${n} teammate${n === 1 ? '' : 's'}`;
  }
  if (p.type === 'agent') return 'Agent · asks each time';
  const member = org?.members.find((m) => m.accountId === p.id);
  if (org && !member) return 'No longer in the organization';
  const parts = [member ? ROLE_LABELS[member.role] : 'Person'];
  if (member?.status === 'invited') parts.push('invited');
  const ends = cells
    .map((c) => c.expiresAt)
    .filter((x): x is string => x !== null)
    .sort()[0];
  if (ends) parts.push(`until ${day(ends)}`);
  return parts.join(' · ');
}

/**
 * One row per principal with a grant anywhere in the project, one cell per
 * environment. Uses each environment's grant list, when loaded, to tell an
 * explicit "No access" from no grant at all.
 */
export function buildMatrix(input: {
  access: ProjectAccessResponse;
  envs: Record<string, EnvironmentAccess | undefined>;
  org: OrgDetail | null;
  meEmail: string;
  day?: (iso: string) => string;
}): MatrixRow[] {
  const { access, envs, org } = input;
  const day = input.day ?? formatDay;
  const me = org?.members.find((m) => m.email.toLowerCase() === input.meEmail.toLowerCase());

  const principals = new Map<string, { principal: PrincipalRef; name: string | null }>();
  for (const r of access.rows) {
    principals.set(principalKey(r.principal), { principal: r.principal, name: r.name });
  }
  for (const env of Object.values(envs)) {
    for (const g of env?.grants ?? []) {
      const key = principalKey(g.principal);
      if (!principals.has(key)) principals.set(key, { principal: g.principal, name: null });
    }
  }

  const rows = [...principals.entries()].map(([key, { principal, name }]): MatrixRow => {
    const from = access.rows.find((r) => principalKey(r.principal) === key);
    const cells = access.environments.map((e): MatrixCell => {
      const cell = from?.cells.find((c) => c.environmentId === e.id);
      const detail = envs[e.id];
      const level = cell?.level ?? 'none';
      return {
        environmentId: e.id,
        level,
        granted: detail
          ? detail.grants.some((g) => principalKey(g.principal) === key)
          : level !== 'none',
        expiresAt: cell?.expiresAt ?? null,
      };
    });
    return {
      key,
      principal,
      name: name ?? nameOf(principal, org),
      detail: detailOf(principal, org, cells, day),
      you: principal.type === 'account' && principal.id === me?.accountId,
      cells,
    };
  });

  const order: Record<PrincipalType, number> = { group: 0, account: 1, agent: 2 };
  return rows.sort(
    (a, b) =>
      order[a.principal.type] - order[b.principal.type] ||
      Number(b.you) - Number(a.you) ||
      a.name.localeCompare(b.name),
  );
}

/** A principal's display name from the organization. */
export function nameOf(p: PrincipalRef, org: OrgDetail | null): string {
  if (p.type === 'group') return org?.groups.find((g) => g.id === p.id)?.name ?? 'Removed group';
  if (p.type === 'agent') return org?.agents.find((a) => a.id === p.id)?.name ?? 'Removed agent';
  return org?.members.find((m) => m.accountId === p.id)?.email ?? 'Removed member';
}

export interface Candidate {
  principal: PrincipalRef;
  name: string;
}

/** Groups, people and agents of the org that have no row in the matrix yet. */
export function candidates(org: OrgDetail, rows: MatrixRow[]): Candidate[] {
  const taken = new Set(rows.map((r) => r.key));
  const all: Candidate[] = [
    ...org.groups.map((g) => ({ principal: { type: 'group' as const, id: g.id }, name: g.name })),
    ...org.members.map((m) => ({
      principal: { type: 'account' as const, id: m.accountId },
      name: m.email,
    })),
    ...org.agents.map((a) => ({ principal: { type: 'agent' as const, id: a.id }, name: a.name })),
  ];
  return all.filter((c) => !taken.has(principalKey(c.principal)));
}

export interface KeyHandOff {
  accountId: string;
  name: string;
  /** What they are still waiting for: environment names, and "project names". */
  waitingFor: string[];
}

/**
 * Members who were given access but hold no wrapped key yet, per what the API
 * lists for this manager. Until a manager's device hands the key over, they
 * see the environment as locked.
 */
export function pendingHandOffs(
  access: ProjectAccessResponse,
  envs: Record<string, EnvironmentAccess | undefined>,
  org: OrgDetail | null,
  envName: (id: string) => string,
): KeyHandOff[] {
  const out = new Map<string, KeyHandOff>();
  const add = (accountId: string, what: string) => {
    const entry = out.get(accountId) ?? {
      accountId,
      name: nameOf({ type: 'account', id: accountId }, org),
      waitingFor: [],
    };
    if (!entry.waitingFor.includes(what)) entry.waitingFor.push(what);
    out.set(accountId, entry);
  };
  for (const w of access.pendingProjectWraps) add(w.accountId, 'project names');
  for (const e of access.environments) {
    for (const w of envs[e.id]?.pendingWraps ?? []) add(w.accountId, envName(e.id));
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Environments flagged for a key rotation after someone lost access. */
export const rotationNeeded = (access: ProjectAccessResponse): string[] =>
  access.environments.filter((e) => e.rotationRequired).map((e) => e.id);

export interface EnvUser {
  key: string;
  type: PrincipalType;
  name: string;
  level: AccessLevel;
  you: boolean;
}

/** Who holds a grant (other than "No access") in one environment, strongest first. */
export function whoCanUse(rows: MatrixRow[], envId: string): EnvUser[] {
  const rank: Record<AccessLevel, number> = {
    manage: 0,
    edit: 1,
    use: 2,
    needs_approval: 3,
    none: 4,
  };
  return rows
    .flatMap((r) => {
      const cell = r.cells.find((c) => c.environmentId === envId);
      if (!cell || cell.level === 'none') return [];
      return [{ key: r.key, type: r.principal.type, name: r.name, level: cell.level, you: r.you }];
    })
    .sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name));
}

/** Whether the signed-in account can change grants in an environment. */
export function canManageEnv(org: OrgDetail | null, env: EnvironmentAccess | undefined): boolean {
  if (org && (org.role === 'owner' || org.role === 'admin')) return true;
  return env?.myLevel === 'manage';
}

/** Owners and admins manage members, groups and agents. */
export const isOrgAdmin = (org: OrgDetail | null): boolean =>
  !!org && (org.role === 'owner' || org.role === 'admin');

/**
 * Everyone who keeps the key when an environment is rotated, the way the API
 * works it out: active members with a published key whose own grant, or else
 * strongest group grant, is Use or above. `always` adds accounts that manage
 * regardless of grants (this account, the project owner).
 */
export function keyHolders(
  env: EnvironmentAccess,
  org: OrgDetail,
  always: string[],
  now: number = Date.now(),
): PendingWrap[] {
  const live = env.grants.filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > now);
  const levelOf = (accountId: string, groupIds: string[]): AccessLevel => {
    const direct = live.find((g) => g.principal.type === 'account' && g.principal.id === accountId);
    if (direct) return direct.level;
    return live
      .filter((g) => g.principal.type === 'group' && groupIds.includes(g.principal.id))
      .reduce<AccessLevel>((best, g) => strongerLevel(best, g.level), 'none');
  };
  return org.members.flatMap((m) => {
    if (!m.publicKey) return [];
    const keeps =
      always.includes(m.accountId) ||
      (m.status === 'active' && holdsKey(levelOf(m.accountId, m.groupIds)));
    return keeps ? [{ accountId: m.accountId, publicKey: m.publicKey }] : [];
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Account ids in the API's "Wrap the new key for everyone with access: …"
 * answer to a rotation, e.g. a project owner this account can't see as such.
 */
export const missingRecipients = (message: string): string[] => [
  ...new Set((message.match(UUID) ?? []).map((id) => id.toLowerCase())),
];

/** Public keys on file for `ids`; `null` if any of them has none. */
export function recipientsFor(org: OrgDetail, ids: string[]): PendingWrap[] | null {
  const out: PendingWrap[] = [];
  for (const id of ids) {
    const m = org.members.find((x) => x.accountId === id);
    if (!m?.publicKey) return null;
    out.push({ accountId: id, publicKey: m.publicKey });
  }
  return out;
}

/** Every value an environment holds, as the rotation re-seals them. */
export function environmentValues(
  secrets: ProjectSecret[],
  projectId: string,
  envId: string,
): { secretId: string; encryptedValue: EncryptedBlob }[] {
  return secrets.flatMap((s) => {
    const encryptedValue = s.projectId === projectId ? s.values[envId] : undefined;
    return encryptedValue ? [{ secretId: s.id, encryptedValue }] : [];
  });
}

/**
 * The sealed values an access request asks for, matched by their `zv://`
 * reference within its environment. Inherited values come from the
 * environment that holds them. `missing` lists references with no value here.
 */
export function releaseItems(
  project: Project,
  secrets: ProjectSecret[],
  envId: string,
  items: string[],
): { items: ReleaseItem[]; missing: string[] } {
  const env = project.environments.find((e) => e.id === envId);
  const out: ReleaseItem[] = [];
  const missing: string[] = [];
  for (const item of items) {
    const path = parseSecretPath(item);
    const secret =
      env && path && path.project === project.slug && path.environment === env.slug
        ? secrets.find(
            (s) =>
              s.projectId === project.id &&
              s.key === path.key &&
              (s.folder?.slug ?? null) === path.folder,
          )
        : undefined;
    const source = secret ? valueSource(project, secret, envId) : null;
    const encryptedValue = source ? secret?.values[source] : undefined;
    if (secret && source && encryptedValue) {
      out.push({ item, secretId: secret.id, environmentId: source, encryptedValue });
    } else {
      missing.push(item);
    }
  }
  return { items: out, missing };
}

import {
  MAX_REPORTED_EVENTS,
  parseSecretPath,
  type ActivityEvent,
  type ReportedEvent,
  type ShareChannel,
} from '@zvault/shared';
import type { ActivityEntry } from '../agents/api.js';
import type { ProjectsApi } from './api.js';
import { LEVEL_LABELS } from './teamModel.js';
import type { Project, ProjectSecret } from './model.js';

/** The same view or copy again within this window is not reported twice. */
const REPEAT_MS = 60_000;
const FLUSH_MS = 1_500;

/**
 * Reports what happens to project secrets on this Mac (views, copies, shares,
 * agent use) to the team activity log. Only ids go to the server. Reporting
 * is best effort: a failure never gets in the way of using the secret.
 */
export class ActivityReporter {
  private readonly queued = new Map<string, ReportedEvent[]>();
  private readonly recent = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Pick<ProjectsApi, 'reportActivity'>,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
  ) {}

  viewed(projectId: string, secretId: string, environmentId: string): void {
    this.add(projectId, { action: 'secret.viewed', secretId, environmentId }, true);
  }

  copied(projectId: string, secretId: string, environmentId: string): void {
    this.add(projectId, { action: 'secret.copied', secretId, environmentId }, true);
  }

  shared(projectId: string, secretId: string, environmentId: string, share: ShareChannel): void {
    this.add(projectId, { action: 'secret.shared', secretId, environmentId, share }, false);
  }

  agent(projectId: string, event: ReportedEvent): void {
    this.add(projectId, event, false);
  }

  /** Sends everything queued now. */
  async flush(): Promise<void> {
    this.timer = null;
    const batches = [...this.queued.entries()];
    this.queued.clear();
    await Promise.all(
      batches.map(async ([projectId, events]) => {
        for (let i = 0; i < events.length; i += MAX_REPORTED_EVENTS) {
          await this.api
            .reportActivity(projectId, events.slice(i, i + MAX_REPORTED_EVENTS))
            .catch(() => undefined);
        }
      }),
    );
  }

  private add(projectId: string, event: ReportedEvent, collapse: boolean): void {
    if (collapse) {
      const key = `${projectId}:${event.action}:${event.secretId}:${event.environmentId}`;
      const at = this.now();
      const last = this.recent.get(key);
      if (last !== undefined && at - last < REPEAT_MS) return;
      this.recent.set(key, at);
    }
    const list = this.queued.get(projectId) ?? [];
    list.push(event);
    this.queued.set(projectId, list);
    this.timer ??= this.schedule(() => void this.flush(), FLUSH_MS);
  }
}

/** Where a `zv://` path points in the synced projects, as ids. */
export function resolveRef(
  ref: string,
  projects: readonly Project[],
  secrets: readonly ProjectSecret[],
): { projectId: string; environmentId: string; secretId: string } | null {
  const path = parseSecretPath(ref);
  if (!path) return null;
  const project = projects.find((p) => p.slug === path.project);
  const env = project?.environments.find((e) => e.slug === path.environment);
  if (!project || !env) return null;
  const folder = path.folder ? project.folders.find((f) => f.slug === path.folder) : null;
  if (folder === undefined) return null;
  const secret = secrets.find(
    (s) =>
      s.projectId === project.id &&
      s.key === path.key &&
      (s.folder?.id ?? null) === (folder?.id ?? null),
  );
  return secret ? { projectId: project.id, environmentId: env.id, secretId: secret.id } : null;
}

/**
 * Turns new entries of the local agent log into activity events. Pairing
 * and unpairing stay local; uses and denials of project secrets are reported,
 * with the agent's name and the kind of command, never its arguments.
 */
export function agentEvents(
  entries: readonly ActivityEntry[],
  projects: readonly Project[],
  secrets: readonly ProjectSecret[],
): { projectId: string; event: ReportedEvent }[] {
  const out: { projectId: string; event: ReportedEvent }[] = [];
  for (const e of entries) {
    const used = e.outcome === 'allowed' || e.outcome === 'approved';
    if (!used && e.outcome !== 'denied') continue;
    for (const ref of e.refs) {
      const at = resolveRef(ref, projects, secrets);
      if (!at) continue;
      out.push({
        projectId: at.projectId,
        event: {
          action: used ? 'agent.used' : 'agent.denied',
          secretId: at.secretId,
          environmentId: at.environmentId,
          agent: {
            name: e.agentName.trim().slice(0, 80) || 'Agent',
            purpose: e.purpose?.kind ?? null,
            verifiedBy: e.verifiedBy,
          },
        },
      });
    }
  }
  return out;
}

/** A stable key for a local agent log entry, to report each one once. */
export const entryKey = (e: ActivityEntry) =>
  `${e.at}:${e.agentId}:${e.outcome}:${e.refs.join(',')}`;

// ------------------------------------------------------------ describing

export type ActivityKind = 'use' | 'change' | 'access';

export const KIND_OF: Record<ActivityEvent['action'], ActivityKind> = {
  'secret.viewed': 'use',
  'secret.copied': 'use',
  'secret.shared': 'use',
  'agent.used': 'use',
  'agent.denied': 'use',
  'secret.created': 'change',
  'secret.updated': 'change',
  'secret.deleted': 'change',
  'secret.purged': 'change',
  'environment.created': 'change',
  'environment.updated': 'change',
  'environment.deleted': 'change',
  'folder.created': 'change',
  'folder.updated': 'change',
  'folder.deleted': 'change',
  'project.updated': 'change',
  'project.linked': 'access',
  'grant.changed': 'access',
  'grant.removed': 'access',
  'key.rotated': 'access',
  'request.created': 'access',
  'request.approved': 'access',
  'request.denied': 'access',
  'token.issued': 'access',
  'token.revoked': 'access',
  'token.used': 'use',
  'token.denied': 'use',
};

export interface DescribedEvent {
  /** Who did it: "You", an email, or an agent's name. */
  who: string;
  /** What they did, after `who`. */
  what: string;
  /** The secret (or other thing) it was about, shown in bold. */
  subject: string | null;
  /** Anything after the subject, such as "in Production". */
  where: string | null;
  kind: ActivityKind;
  tone: 'neutral' | 'positive' | 'negative';
}

/**
 * Words for one event. Names come from this Mac's decrypted copy of the
 * project; the server only sent ids.
 */
export function describeEvent(
  e: ActivityEvent,
  ctx: {
    project: Project;
    secrets: readonly ProjectSecret[];
    meEmail: string;
  },
): DescribedEvent {
  const { project } = ctx;
  const me = ctx.meEmail.toLowerCase();
  const you = e.actor.type === 'account' && e.actor.name?.toLowerCase() === me;
  const who = you
    ? 'You'
    : (e.actor.name ?? (e.actor.type === 'agent' ? 'A removed agent' : 'A removed member'));
  const env = project.environments.find((x) => x.id === e.environmentId);
  const inEnv = env ? `in ${env.name}` : null;
  const secret = ctx.secrets.find((s) => s.projectId === project.id && s.id === e.targetId);
  const secretName = secret ? secret.key : 'a deleted secret';
  const folder = project.folders.find((f) => f.id === e.targetId);
  const principal = e.detail.principal;
  const principalName = principal
    ? principal.type === 'account' && principal.name?.toLowerCase() === me
      ? 'you'
      : (principal.name ?? `a removed ${principal.type === 'group' ? 'group' : 'member'}`)
    : 'someone';
  const base = { who, kind: KIND_OF[e.action], tone: 'neutral' as DescribedEvent['tone'] };
  const agentName = e.detail.agent?.name ?? 'an agent';
  const tokenName = `“${e.detail.token?.name ?? 'a token'}”`;
  const forEnv = env ? `for ${env.name}` : null;
  const items = (n: number | undefined, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n ?? 0} ${many}`;

  switch (e.action) {
    case 'secret.viewed':
      return { ...base, what: 'revealed', subject: secretName, where: inEnv };
    case 'secret.copied':
      return { ...base, what: 'copied', subject: secretName, where: inEnv };
    case 'secret.shared':
      return {
        ...base,
        what: e.detail.share === 'person' ? 'shared with a Zvault user' : 'shared a secure link to',
        subject: secretName,
        where: inEnv,
      };
    case 'agent.used': {
      const purpose = e.detail.agent?.purpose;
      const verified = e.detail.agent?.verifiedBy === 'touchId' ? ', approved with Touch ID' : '';
      return {
        ...base,
        what: `let ${agentName} use`,
        subject: secretName,
        where:
          [inEnv, purpose ? `for zv ${purpose}${verified}` : verified.slice(2) || null]
            .filter(Boolean)
            .join(' ') || null,
      };
    }
    case 'agent.denied':
      return {
        ...base,
        what: `turned down ${agentName} for`,
        subject: secretName,
        where: inEnv,
        tone: 'negative',
      };
    case 'secret.created':
      return { ...base, what: 'added', subject: secretName, where: inEnv, tone: 'positive' };
    case 'secret.updated':
      return { ...base, what: inEnv ? 'changed' : 'edited', subject: secretName, where: inEnv };
    case 'secret.deleted':
      return {
        ...base,
        what: 'moved to Trash',
        subject: secretName,
        where: null,
        tone: 'negative',
      };
    case 'secret.purged':
      return e.targetId
        ? { ...base, what: 'deleted for good', subject: secretName, where: null, tone: 'negative' }
        : {
            ...base,
            what: 'emptied the Trash',
            subject: null,
            where: `(${items(e.detail.items, 'secret', 'secrets')})`,
            tone: 'negative',
          };
    case 'environment.created':
    case 'environment.updated':
    case 'environment.deleted': {
      const verb = { created: 'created', updated: 'edited', deleted: 'deleted' }[
        e.action.split('.')[1] as 'created' | 'updated' | 'deleted'
      ];
      return {
        ...base,
        what: `${verb} the environment`,
        subject: env?.name ?? 'a deleted environment',
        where: null,
        tone: e.action === 'environment.deleted' ? 'negative' : 'neutral',
      };
    }
    case 'folder.created':
    case 'folder.updated':
    case 'folder.deleted': {
      const verb = { created: 'created', updated: 'renamed', deleted: 'deleted' }[
        e.action.split('.')[1] as 'created' | 'updated' | 'deleted'
      ];
      return {
        ...base,
        what: `${verb} the folder`,
        subject: folder?.name ?? 'a deleted folder',
        where: null,
      };
    }
    case 'project.updated':
      return { ...base, what: 'edited the project', subject: project.name, where: null };
    case 'project.linked':
      return { ...base, what: 'shared the project with the team', subject: null, where: null };
    case 'grant.changed':
      return {
        ...base,
        what: e.detail.level === 'none' ? 'blocked' : 'gave',
        subject: principalName,
        where:
          e.detail.level === 'none'
            ? (inEnv ?? null)
            : `${LEVEL_LABELS[e.detail.level ?? 'use']} ${inEnv ?? ''}`.trim(),
        tone: e.detail.level === 'none' ? 'negative' : 'neutral',
      };
    case 'grant.removed':
      return {
        ...base,
        what: 'removed the access of',
        subject: principalName,
        where: inEnv,
        tone: 'negative',
      };
    case 'key.rotated':
      return {
        ...base,
        what: 'rotated the key of',
        subject: env?.name ?? 'an environment',
        where: `(${items(e.detail.items, 'value', 'values')} re-sealed)`,
      };
    case 'request.created':
      return {
        ...base,
        what: 'asked to use',
        subject: items(e.detail.items, 'secret', 'secrets'),
        where: inEnv,
      };
    case 'request.approved':
      return {
        ...base,
        what: 'approved',
        subject: `${principalName}’s request`,
        where: [`for ${items(e.detail.items, 'secret', 'secrets')}`, inEnv]
          .filter(Boolean)
          .join(' '),
        tone: 'positive',
      };
    case 'request.denied':
      return {
        ...base,
        what: 'denied',
        subject: `${principalName}’s request`,
        where: inEnv,
        tone: 'negative',
      };
    case 'token.issued':
      return { ...base, what: 'made the token', subject: tokenName, where: forEnv };
    case 'token.revoked':
      return {
        ...base,
        what: 'revoked the token',
        subject: tokenName,
        where: null,
        tone: 'negative',
      };
    case 'token.used':
      return {
        ...base,
        who: `The token ${tokenName}`,
        what: 'read',
        subject: env?.name ?? 'an environment',
        where: 'with zv',
      };
    case 'token.denied':
      return {
        ...base,
        who: `The token ${tokenName}`,
        what: 'was refused',
        subject: null,
        where: TOKEN_REFUSALS[e.detail.token?.reason ?? 'expired'],
        tone: 'negative',
      };
  }
}

const TOKEN_REFUSALS: Record<
  NonNullable<ActivityEvent['detail']['token']>['reason'] & string,
  string
> = {
  expired: '(it had expired)',
  stale: '(the key was rotated since)',
  creator_lost_access: '(its creator lost access)',
  environment_deleted: '(its environment was deleted)',
};

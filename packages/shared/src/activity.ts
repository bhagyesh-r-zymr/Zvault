import { z } from 'zod';
import { AccessLevel, PrincipalType } from './access.js';
import { RecordId } from './vault.js';

/**
 * The team activity log: who viewed, copied, shared, changed or approved
 * what in a project. Events hold ids and outcomes, never values or names
 * sealed with the project key: the app shows secret and environment names
 * from its own decrypted copy of the project.
 *
 * The server records every change it takes part in (writes, grants,
 * rotations, approvals). Views, copies, shares and agent use happen on a
 * device, which reports them with {@link ReportActivityRequest}.
 */

/** Days events are kept before the server drops them. */
export const ACTIVITY_RETENTION_DAYS = 365;

/** Events per page of {@link ActivityPageResponse}. */
export const ACTIVITY_PAGE_SIZE = 50;

/** Events a device may report in one request. */
export const MAX_REPORTED_EVENTS = 50;

export const ActivityAction = z.enum([
  // Reported by a device.
  'secret.viewed',
  'secret.copied',
  'secret.shared',
  'agent.used',
  'agent.denied',
  // Recorded by the server.
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.purged',
  'environment.created',
  'environment.updated',
  'environment.deleted',
  'folder.created',
  'folder.updated',
  'folder.deleted',
  'project.updated',
  'project.linked',
  'grant.changed',
  'grant.removed',
  'key.rotated',
  'request.created',
  'request.approved',
  'request.denied',
  'token.issued',
  'token.revoked',
  'token.used',
  'token.denied',
]);
export type ActivityAction = z.infer<typeof ActivityAction>;

/** The actions a device reports; the server records the rest itself. */
export const ReportedAction = ActivityAction.extract([
  'secret.viewed',
  'secret.copied',
  'secret.shared',
  'agent.used',
  'agent.denied',
]);
export type ReportedAction = z.infer<typeof ReportedAction>;

/** How a secret was shared. */
export const ShareChannel = z.enum(['link', 'person']);
export type ShareChannel = z.infer<typeof ShareChannel>;

/** What a local agent (`zv` on the member's Mac) did with a secret. */
export const AgentUse = z.object({
  /** The name the member gave the agent when pairing it. */
  name: z.string().trim().min(1).max(80),
  /** The `zv` command kind, such as `run` or `read`; never its arguments. */
  purpose: z
    .string()
    .regex(/^[a-z][a-zA-Z]{0,31}$/)
    .nullable(),
  /** How the member approved it, when a prompt was shown. */
  verifiedBy: z.enum(['touchId', 'click']).nullable(),
});
export type AgentUse = z.infer<typeof AgentUse>;

/** Small, non-secret facts about an event. Every field is optional. */
export const ActivityDetail = z.object({
  /** Grants: whose access changed, and to what. */
  principal: z
    .object({ type: PrincipalType, id: z.uuid(), name: z.string().nullable() })
    .optional(),
  level: AccessLevel.optional(),
  /** Rotations: the new key version. */
  keyVersion: z.number().int().min(1).optional(),
  /** Requests: how many values were asked for or released. */
  items: z.number().int().min(0).optional(),
  share: ShareChannel.optional(),
  agent: AgentUse.optional(),
  /** Access tokens (`ZVAULT_TOKEN`): the token's name, and why it was refused. */
  token: z
    .object({
      name: z.string().max(100),
      reason: z.enum(['expired', 'stale', 'creator_lost_access', 'environment_deleted']).optional(),
    })
    .optional(),
});
export type ActivityDetail = z.infer<typeof ActivityDetail>;

export const ActivityActor = z.object({
  type: z.enum(['account', 'agent']),
  id: z.uuid(),
  /** The account's email or the agent's name; null once it is gone. */
  name: z.string().nullable(),
});
export type ActivityActor = z.infer<typeof ActivityActor>;

export const ActivityEvent = z.object({
  /** Increasing; pass the last one as `before` for the next page. */
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  action: ActivityAction,
  actor: ActivityActor,
  /** The environment it happened in, if any. */
  environmentId: RecordId.nullable(),
  /** The secret, folder, environment or request it was about, if any. */
  targetId: z.uuid().nullable(),
  detail: ActivityDetail,
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityPageQuery = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_SIZE).default(ACTIVITY_PAGE_SIZE),
  secretId: RecordId.optional(),
});
export type ActivityPageQuery = z.infer<typeof ActivityPageQuery>;

/** Newest first. */
export const ActivityPageResponse = z.object({
  events: z.array(ActivityEvent),
  hasMore: z.boolean(),
});
export type ActivityPageResponse = z.infer<typeof ActivityPageResponse>;

export const ReportedEvent = z
  .object({
    action: ReportedAction,
    secretId: RecordId,
    environmentId: RecordId,
    share: ShareChannel.optional(),
    agent: AgentUse.optional(),
  })
  .refine((e) => (e.action === 'secret.shared') === (e.share !== undefined), {
    message: 'share is set exactly for secret.shared',
  })
  .refine((e) => e.action.startsWith('agent.') === (e.agent !== undefined), {
    message: 'agent is set exactly for agent events',
  });
export type ReportedEvent = z.infer<typeof ReportedEvent>;

export const ReportActivityRequest = z.object({
  events: z.array(ReportedEvent).min(1).max(MAX_REPORTED_EVENTS),
});
export type ReportActivityRequest = z.infer<typeof ReportActivityRequest>;

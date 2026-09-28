import { Injectable } from '@nestjs/common';
import { ActivityLog } from '../activity/activity.log.js';

/** Something that happened to an access token. Ids and names only, never key material. */
export type TokenEvent = {
  tokenId: string;
  projectId: string;
  environmentId: string;
  name: string;
} & (
  | { kind: 'issued' | 'revoked'; accountId: string }
  | { kind: 'used'; createdBy: string }
  | {
      kind: 'denied';
      createdBy: string;
      reason: 'expired' | 'stale' | 'creator_lost_access' | 'environment_deleted';
    }
);

/**
 * Reports token events to the project's activity log. Use and refusals are
 * attributed to the token's creator, with the token named in the detail.
 */
@Injectable()
export class TokenActivity {
  constructor(private readonly log: ActivityLog) {}

  record(e: TokenEvent): Promise<void> {
    const actorId = 'accountId' in e ? e.accountId : e.createdBy;
    return this.log.record({
      projectId: e.projectId,
      action: `token.${e.kind}`,
      actor: { type: 'account', id: actorId },
      environmentId: e.environmentId,
      targetId: e.tokenId,
      detail: { token: { name: e.name, ...(e.kind === 'denied' && { reason: e.reason }) } },
    });
  }
}

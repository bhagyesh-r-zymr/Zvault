import { Injectable, Logger } from '@nestjs/common';

/** Something that happened to an access token. Ids only, never key material. */
export type TokenEvent =
  | { kind: 'issued'; tokenId: string; projectId: string; accountId: string; name: string }
  | { kind: 'revoked'; tokenId: string; projectId: string; accountId: string }
  | { kind: 'used'; tokenId: string; projectId: string; environmentIds: string[] }
  | {
      kind: 'denied';
      tokenId: string;
      projectId: string;
      reason: 'expired' | 'stale' | 'creator_lost_access' | 'environment_deleted';
    };

/**
 * Where token events go. Today they are logged; an activity log can replace
 * this provider (or wrap `record`) to store them.
 */
@Injectable()
export class TokenActivity {
  private readonly log = new Logger('AgentTokens');

  record(event: TokenEvent): void | Promise<void> {
    this.log.log(JSON.stringify(event));
  }
}

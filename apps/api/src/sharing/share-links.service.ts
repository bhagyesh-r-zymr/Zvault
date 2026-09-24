import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SHARE_LIMITS,
  type CreateShareLinkRequest,
  type OpenShareLinkRequest,
  type OpenShareLinkResponse,
  type ShareId,
  type ShareLinkSummary,
} from '@zvault/shared';
import { type Clock, SHARE_CLOCK } from './clock.js';
import { type LinkRecord, SHARE_STORE, type ShareStore } from './share.store.js';

const decode = (b64url: string) => Buffer.from(b64url, 'base64url');

@Injectable()
export class ShareLinksService {
  constructor(
    @Inject(SHARE_STORE) private readonly store: ShareStore,
    @Inject(SHARE_CLOCK) private readonly now: Clock,
  ) {}

  async create(ownerId: string, req: CreateShareLinkRequest): Promise<ShareLinkSummary> {
    const now = this.now();
    if ((await this.store.countActiveLinks(ownerId, now)) >= SHARE_LIMITS.maxActiveLinksPerUser) {
      throw new UnprocessableEntityException('Too many active share links; revoke some first');
    }
    const link: LinkRecord = {
      id: req.id,
      ownerId,
      blob: req.blob,
      verifier: decode(req.verifier),
      createdAt: now,
      expiresAt: new Date(now.getTime() + req.expiresInSeconds * 1000),
      maxViews: req.maxViews,
      viewCount: 0,
      revokedAt: null,
    };
    if (!(await this.store.insertLink(link)))
      throw new ConflictException('Share id already in use');
    return this.summarize(link, now);
  }

  async list(ownerId: string): Promise<ShareLinkSummary[]> {
    const now = this.now();
    return (await this.store.listLinks(ownerId)).map((l) => this.summarize(l, now));
  }

  async revoke(ownerId: string, id: ShareId): Promise<void> {
    if (!(await this.store.revokeLink(id, ownerId, this.now()))) throw new NotFoundException();
  }

  /**
   * Returns the ciphertext and counts a view, but only for a caller that holds
   * the link key. Every failure looks the same so the endpoint reveals nothing
   * about which links exist.
   */
  async open(id: ShareId, req: OpenShareLinkRequest): Promise<OpenShareLinkResponse> {
    const presented = createHash('sha256').update(decode(req.accessToken)).digest();
    const link = await this.store.consumeLinkView(id, this.now(), (l) =>
      timingSafeEqual(presented, l.verifier),
    );
    if (!link?.blob) throw new NotFoundException();
    return {
      blob: link.blob,
      expiresAt: link.expiresAt.toISOString(),
      viewsRemaining: link.maxViews - link.viewCount - 1,
    };
  }

  private summarize(link: LinkRecord, now: Date): ShareLinkSummary {
    const status = link.revokedAt
      ? 'revoked'
      : link.viewCount >= link.maxViews
        ? 'used_up'
        : link.expiresAt <= now
          ? 'expired'
          : 'active';
    return {
      id: link.id,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
      maxViews: link.maxViews,
      viewCount: link.viewCount,
      status,
    };
  }
}

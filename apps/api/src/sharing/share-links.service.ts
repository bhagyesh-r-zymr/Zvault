import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
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
  SHARE_LIMITS,
  type CheckShareLinkResponse,
  type CreateShareLinkResponse,
  type CreateShareLinkRequest,
  type OpenShareLinkRequest,
  type OpenShareLinkResponse,
  type RequestShareCodeRequest,
  type ShareId,
  type ShareLinkDenial,
  type ShareLinkSummary,
} from '@zvault/shared';
import { hmac } from '../auth/tokens.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { Mailer } from '../mail/mailer.js';
import { shareCodeEmail } from '../mail/templates.js';
import { type Clock, SHARE_CLOCK } from './clock.js';
import { type LinkRecord, SHARE_STORE, type ShareStore } from './share.store.js';

const decode = (b64url: string) => Buffer.from(b64url, 'base64url');

const DENIALS: Record<ShareLinkDenial['reason'], string> = {
  email_required: 'Confirm your email to open this item.',
  invalid_code: 'That code is wrong or has expired. Ask for a new one.',
};

@Injectable()
export class ShareLinksService {
  private readonly logger = new Logger('ShareLinks');

  constructor(
    @Inject(SHARE_STORE) private readonly store: ShareStore,
    @Inject(SHARE_CLOCK) private readonly now: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  async create(ownerId: string, req: CreateShareLinkRequest): Promise<CreateShareLinkResponse> {
    const now = this.now();
    if ((await this.store.countActiveLinks(ownerId, now)) >= SHARE_LIMITS.maxActiveLinksPerUser) {
      throw new UnprocessableEntityException('Too many active share links; revoke some first');
    }
    const link: LinkRecord = {
      id: req.id,
      ownerId,
      blob: req.blob,
      verifier: decode(req.verifier),
      allowedEmails:
        req.allowedEmails?.map((e) => this.emailHash(req.id, e).toString('base64url')) ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + req.expiresInSeconds * 1000),
      maxViews: req.maxViews,
      viewCount: 0,
      revokedAt: null,
    };
    if (!(await this.store.insertLink(link)))
      throw new ConflictException('Share id already in use');
    return {
      ...this.summarize(link, now),
      unverifiedEmails: await this.unverified(req.allowedEmails),
    };
  }

  async list(ownerId: string): Promise<ShareLinkSummary[]> {
    const now = this.now();
    return (await this.store.listLinks(ownerId)).map((l) => this.summarize(l, now));
  }

  async revoke(ownerId: string, id: ShareId): Promise<void> {
    if (!(await this.store.revokeLink(id, ownerId, this.now()))) throw new NotFoundException();
  }

  /**
   * Tells a caller holding the link key whether it needs an email check.
   * Counts no view. Unknown, closed and wrong-key links all look the same.
   */
  async check(id: ShareId, accessToken: string): Promise<CheckShareLinkResponse> {
    const link = await this.openLinkFor(id, accessToken);
    return { emailRequired: link.allowedEmails !== null };
  }

  /**
   * Emails a one-time code if `email` may open the link. The caller learns
   * nothing either way: the answer is the same and the email is sent in the
   * background, so timing doesn't tell either.
   */
  async requestCode(id: ShareId, req: RequestShareCodeRequest): Promise<void> {
    const now = this.now();
    const link = await this.openLinkFor(id, req.accessToken);
    const emailHash = this.emailHash(id, req.email);
    if (!link.allowedEmails?.includes(emailHash.toString('base64url'))) return;

    const code = randomInt(0, 10 ** SHARE_LIMITS.codeLength)
      .toString()
      .padStart(SHARE_LIMITS.codeLength, '0');
    const issued = await this.store.issueLinkCode({
      linkId: id,
      emailHash,
      codeHash: this.codeHash(id, req.email, code),
      now,
      expiresAt: new Date(now.getTime() + SHARE_LIMITS.codeTtlMinutes * 60_000),
    });
    if (!issued) return;
    void this.store
      .accountEmail(link.ownerId)
      .then((sender) =>
        this.mailer.send(shareCodeEmail(req.email, sender, code, SHARE_LIMITS.codeTtlMinutes)),
      )
      // Ids only: email addresses are personal data and stay out of logs.
      .catch((e: unknown) =>
        this.logger.error(`Could not email a code for link ${id}: ${String(e)}`),
      );
  }

  /**
   * Returns the ciphertext and counts a view, but only for a caller that holds
   * the link key and, for an email-restricted link, a live code for one of its
   * emails. Callers without the key all get the same 404, so the endpoint
   * reveals nothing about which links exist.
   */
  async open(id: ShareId, req: OpenShareLinkRequest): Promise<OpenShareLinkResponse> {
    const presented = this.verifierOf(req.accessToken);
    const code =
      req.email && req.code
        ? {
            emailHash: this.emailHash(id, req.email),
            codeHash: this.codeHash(id, req.email, req.code),
          }
        : undefined;
    const result = await this.store.consumeLinkView(
      id,
      this.now(),
      (l) => timingSafeEqual(presented, l.verifier),
      code,
    );
    if (!result.ok) {
      if (result.reason === 'not_found') throw new NotFoundException();
      throw new ForbiddenException({ reason: result.reason, message: DENIALS[result.reason] });
    }
    const link = result.link;
    if (!link.blob) throw new NotFoundException();
    return {
      blob: link.blob,
      expiresAt: link.expiresAt.toISOString(),
      viewsRemaining: link.maxViews - link.viewCount - 1,
    };
  }

  /**
   * In SES sandbox mode, the allowed emails with no sign they can get mail.
   * Accounts and verified waitlist joiners have been through SES already.
   */
  private async unverified(emails: string[] | undefined): Promise<string[]> {
    if (!this.env.MAIL_SANDBOX || !emails?.length) return [];
    const reachable = await this.store.knownReachableEmails(emails);
    return emails.filter((e) => !reachable.has(e));
  }

  private async openLinkFor(id: ShareId, accessToken: string): Promise<LinkRecord> {
    const presented = this.verifierOf(accessToken);
    const link = await this.store.getOpenLink(id, this.now());
    if (!link || !timingSafeEqual(presented, link.verifier)) throw new NotFoundException();
    return link;
  }

  private verifierOf(accessToken: string): Buffer {
    return createHash('sha256').update(decode(accessToken)).digest();
  }

  /** Salted with the link id, so one person can't be linked across shares. */
  private emailHash(id: ShareId, email: string): Buffer {
    return hmac(this.env.SERVER_SECRET, 'share-recipient', id, email);
  }

  private codeHash(id: ShareId, email: string, code: string): Buffer {
    return hmac(this.env.SERVER_SECRET, 'share-code', id, email, code);
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
      allowedEmailCount: link.allowedEmails?.length ?? 0,
      status,
    };
  }
}

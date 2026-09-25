import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EncryptedBlob, ShareId, SharingPublicKey } from '@zvault/shared';
import { and, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, shareLinkCodes, shareLinks, sharingKeys, userShares } from '../db/schema.js';

export interface LinkRecord {
  id: ShareId;
  ownerId: string;
  /** Dropped as soon as the link can no longer be opened. */
  blob: EncryptedBlob | null;
  verifier: Buffer;
  /** Keyed hashes of the emails allowed to open it; null means anyone with the link. */
  allowedEmails: string[] | null;
  createdAt: Date;
  expiresAt: Date;
  maxViews: number;
  viewCount: number;
  revokedAt: Date | null;
}

export interface SharingKeyRecord {
  userId: string;
  email: string;
  publicKey: SharingPublicKey;
  updatedAt: Date;
}

export interface UserShareRecord {
  id: ShareId;
  senderId: string;
  senderEmail: string;
  senderPublicKey: SharingPublicKey;
  recipientId: string;
  recipientEmail: string;
  ephemeralPublicKey: SharingPublicKey;
  blob: EncryptedBlob;
  createdAt: Date;
  expiresAt: Date | null;
}

/** A one-time code presented for an email-restricted link, as keyed hashes. */
export interface PresentedCode {
  emailHash: Buffer;
  codeHash: Buffer;
}

export type ConsumeResult =
  | { ok: true; link: LinkRecord }
  | { ok: false; reason: 'not_found' | 'email_required' | 'invalid_code' };

export interface NewLinkCode extends PresentedCode {
  linkId: ShareId;
  now: Date;
  expiresAt: Date;
}

/** Limits on emailing codes, per link and email. */
export const CODE_LIMITS = {
  cooldownMs: 30_000,
  perHour: 5,
  /** Wrong guesses before a code stops working. */
  maxAttempts: 5,
} as const;

/** Persistence for sharing. */
export interface ShareStore {
  insertLink(link: LinkRecord): Promise<boolean>;
  /** The link if it can still be opened at `now`. */
  getOpenLink(id: ShareId, now: Date): Promise<LinkRecord | null>;
  listLinks(ownerId: string): Promise<LinkRecord[]>;
  countActiveLinks(ownerId: string, now: Date): Promise<number>;
  /**
   * Atomically: if the link is open at `now`, `check` accepts it and (for an
   * email-restricted link) `code` matches a live code, spend the code, count
   * one view (dropping the ciphertext if that was the last one) and return
   * the record as it was before the view was counted.
   */
  consumeLinkView(
    id: ShareId,
    now: Date,
    check: (link: LinkRecord) => boolean,
    code?: PresentedCode,
  ): Promise<ConsumeResult>;
  revokeLink(id: ShareId, ownerId: string, now: Date): Promise<boolean>;
  /**
   * Stores a new code for a link and email, replacing any earlier one. Returns
   * false, storing nothing, when that pair is over its sending limits.
   */
  issueLinkCode(code: NewLinkCode): Promise<boolean>;
  accountEmail(userId: string): Promise<string | null>;

  putSharingKey(key: SharingKeyRecord): Promise<void>;
  getSharingKeyByUser(userId: string): Promise<SharingKeyRecord | null>;
  getSharingKeyByEmail(email: string): Promise<SharingKeyRecord | null>;

  insertUserShare(share: UserShareRecord): Promise<boolean>;
  listIncoming(recipientId: string, now: Date): Promise<UserShareRecord[]>;
  listOutgoing(senderId: string, now: Date): Promise<UserShareRecord[]>;
  /** Deletes a share if `userId` is its sender or recipient. */
  deleteUserShare(id: ShareId, userId: string): Promise<boolean>;
}

export const SHARE_STORE = Symbol('SHARE_STORE');

export const isLinkOpen = (link: LinkRecord, now: Date): boolean =>
  link.revokedAt === null && link.expiresAt > now && link.viewCount < link.maxViews;

type LinkRow = typeof shareLinks.$inferSelect;
type UserShareRow = typeof userShares.$inferSelect;

const toLink = (r: LinkRow): LinkRecord => ({
  id: r.id,
  ownerId: r.ownerId,
  blob: r.blob,
  verifier: r.verifier,
  allowedEmails: r.allowedEmails,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  maxViews: r.maxViews,
  viewCount: r.viewCount,
  revokedAt: r.revokedAt,
});

const toUserShare = (r: UserShareRow): UserShareRecord => ({ ...r });

const liveAt = (now: Date) => or(isNull(userShares.expiresAt), gt(userShares.expiresAt, now));

/** Postgres store. Links survive restarts and deploys. */
@Injectable()
export class PostgresShareStore implements ShareStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insertLink(link: LinkRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(shareLinks)
      .values(link)
      .onConflictDoNothing({ target: shareLinks.id })
      .returning({ id: shareLinks.id });
    return inserted.length > 0;
  }

  async getOpenLink(id: ShareId, now: Date): Promise<LinkRecord | null> {
    const [row] = await this.db.select().from(shareLinks).where(eq(shareLinks.id, id)).limit(1);
    const link = row ? toLink(row) : null;
    return link && isLinkOpen(link, now) ? link : null;
  }

  async listLinks(ownerId: string): Promise<LinkRecord[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.ownerId, ownerId))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map(toLink);
  }

  async countActiveLinks(ownerId: string, now: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.ownerId, ownerId),
          isNull(shareLinks.revokedAt),
          gt(shareLinks.expiresAt, now),
          lt(shareLinks.viewCount, shareLinks.maxViews),
        ),
      );
    return row?.n ?? 0;
  }

  consumeLinkView(
    id: ShareId,
    now: Date,
    check: (link: LinkRecord) => boolean,
    code?: PresentedCode,
  ): Promise<ConsumeResult> {
    const notFound = { ok: false, reason: 'not_found' } as const;
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(shareLinks).where(eq(shareLinks.id, id)).for('update');
      if (!row) return notFound;
      const link = toLink(row);
      if (!isLinkOpen(link, now)) {
        if (row.blob) await tx.update(shareLinks).set({ blob: null }).where(eq(shareLinks.id, id));
        return notFound;
      }
      if (!check(link)) return notFound;

      if (link.allowedEmails) {
        if (!code) return { ok: false, reason: 'email_required' } as const;
        const [pending] = await tx
          .select()
          .from(shareLinkCodes)
          .where(
            and(
              eq(shareLinkCodes.linkId, id),
              eq(shareLinkCodes.emailHash, code.emailHash),
              isNull(shareLinkCodes.closedAt),
              gt(shareLinkCodes.expiresAt, now),
            ),
          )
          .orderBy(desc(shareLinkCodes.createdAt))
          .limit(1)
          .for('update');
        if (!pending) return { ok: false, reason: 'invalid_code' } as const;
        const matches = timingSafeEqual(pending.codeHash, code.codeHash);
        const attempts = pending.attempts + (matches ? 0 : 1);
        await tx
          .update(shareLinkCodes)
          .set({
            attempts,
            closedAt: matches || attempts >= CODE_LIMITS.maxAttempts ? now : null,
          })
          .where(eq(shareLinkCodes.id, pending.id));
        if (!matches) return { ok: false, reason: 'invalid_code' } as const;
      }

      const viewCount = row.viewCount + 1;
      await tx
        .update(shareLinks)
        .set({ viewCount, blob: viewCount >= row.maxViews ? null : row.blob })
        .where(eq(shareLinks.id, id));
      return { ok: true, link } as const;
    });
  }

  async revokeLink(id: ShareId, ownerId: string, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(shareLinks)
      .set({ revokedAt: sql`coalesce(${shareLinks.revokedAt}, ${now})`, blob: null })
      .where(and(eq(shareLinks.id, id), eq(shareLinks.ownerId, ownerId)))
      .returning({ id: shareLinks.id });
    return updated.length > 0;
  }

  issueLinkCode(code: NewLinkCode): Promise<boolean> {
    const { linkId, emailHash, codeHash, now, expiresAt } = code;
    return this.db.transaction(async (tx) => {
      // Serializes code requests for one link, so the limits can't be raced.
      await tx
        .select({ id: shareLinks.id })
        .from(shareLinks)
        .where(eq(shareLinks.id, linkId))
        .for('update');
      const forEmail = and(
        eq(shareLinkCodes.linkId, linkId),
        eq(shareLinkCodes.emailHash, emailHash),
      );
      const recent = await tx
        .select({ createdAt: shareLinkCodes.createdAt })
        .from(shareLinkCodes)
        .where(and(forEmail, gt(shareLinkCodes.createdAt, new Date(now.getTime() - 3_600_000))))
        .orderBy(desc(shareLinkCodes.createdAt));
      const last = recent[0]?.createdAt;
      if (
        recent.length >= CODE_LIMITS.perHour ||
        (last && now.getTime() - last.getTime() < CODE_LIMITS.cooldownMs)
      ) {
        return false;
      }
      await tx
        .update(shareLinkCodes)
        .set({ closedAt: now })
        .where(and(forEmail, isNull(shareLinkCodes.closedAt)));
      await tx
        .insert(shareLinkCodes)
        .values({ linkId, emailHash, codeHash, expiresAt, createdAt: now });
      return true;
    });
  }

  async accountEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, userId))
      .limit(1);
    return row?.email ?? null;
  }

  async putSharingKey(key: SharingKeyRecord): Promise<void> {
    const record = { ...key, email: key.email.toLowerCase() };
    await this.db
      .insert(sharingKeys)
      .values(record)
      .onConflictDoUpdate({
        target: sharingKeys.userId,
        set: { email: record.email, publicKey: record.publicKey, updatedAt: record.updatedAt },
      });
  }

  async getSharingKeyByUser(userId: string): Promise<SharingKeyRecord | null> {
    const [row] = await this.db
      .select()
      .from(sharingKeys)
      .where(eq(sharingKeys.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async getSharingKeyByEmail(email: string): Promise<SharingKeyRecord | null> {
    const [row] = await this.db
      .select()
      .from(sharingKeys)
      .where(eq(sharingKeys.email, email.toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async insertUserShare(share: UserShareRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(userShares)
      .values(share)
      .onConflictDoNothing({ target: userShares.id })
      .returning({ id: userShares.id });
    return inserted.length > 0;
  }

  async listIncoming(recipientId: string, now: Date): Promise<UserShareRecord[]> {
    const rows = await this.db
      .select()
      .from(userShares)
      .where(and(eq(userShares.recipientId, recipientId), liveAt(now)))
      .orderBy(desc(userShares.createdAt));
    return rows.map(toUserShare);
  }

  async listOutgoing(senderId: string, now: Date): Promise<UserShareRecord[]> {
    const rows = await this.db
      .select()
      .from(userShares)
      .where(and(eq(userShares.senderId, senderId), liveAt(now)))
      .orderBy(desc(userShares.createdAt));
    return rows.map(toUserShare);
  }

  async deleteUserShare(id: ShareId, userId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(userShares)
      .where(
        and(
          eq(userShares.id, id),
          or(eq(userShares.senderId, userId), eq(userShares.recipientId, userId)),
        ),
      )
      .returning({ id: userShares.id });
    return deleted.length > 0;
  }
}

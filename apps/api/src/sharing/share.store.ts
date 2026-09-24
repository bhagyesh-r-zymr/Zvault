import { Injectable } from '@nestjs/common';
import type { EncryptedBlob, ShareId, SharingPublicKey } from '@zvault/shared';

export interface LinkRecord {
  id: ShareId;
  ownerId: string;
  /** Dropped as soon as the link can no longer be opened. */
  blob: EncryptedBlob | null;
  verifier: Buffer;
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

/**
 * Persistence for sharing. The in-memory implementation below backs local
 * development and tests; the DynamoDB one must keep the same atomicity, in
 * particular `consumeLinkView` as a single conditional update.
 */
export interface ShareStore {
  insertLink(link: LinkRecord): Promise<boolean>;
  getLink(id: string): Promise<LinkRecord | null>;
  listLinks(ownerId: string): Promise<LinkRecord[]>;
  countActiveLinks(ownerId: string, now: Date): Promise<number>;
  /**
   * Atomically: if the link is open at `now` and `check` accepts it, count one
   * view (dropping the ciphertext if that was the last one) and return the
   * record as it was before the view was counted. Otherwise return null.
   */
  consumeLinkView(
    id: string,
    now: Date,
    check: (link: LinkRecord) => boolean,
  ): Promise<LinkRecord | null>;
  revokeLink(id: string, ownerId: string, now: Date): Promise<boolean>;

  putSharingKey(key: SharingKeyRecord): Promise<void>;
  getSharingKeyByUser(userId: string): Promise<SharingKeyRecord | null>;
  getSharingKeyByEmail(email: string): Promise<SharingKeyRecord | null>;

  insertUserShare(share: UserShareRecord): Promise<boolean>;
  listIncoming(recipientId: string, now: Date): Promise<UserShareRecord[]>;
  listOutgoing(senderId: string, now: Date): Promise<UserShareRecord[]>;
  /** Deletes a share if `userId` is its sender or recipient. */
  deleteUserShare(id: string, userId: string): Promise<boolean>;
}

export const SHARE_STORE = Symbol('SHARE_STORE');

export const isLinkOpen = (link: LinkRecord, now: Date): boolean =>
  link.revokedAt === null && link.expiresAt > now && link.viewCount < link.maxViews;

const isLive = (share: UserShareRecord, now: Date): boolean =>
  share.expiresAt === null || share.expiresAt > now;

@Injectable()
export class InMemoryShareStore implements ShareStore {
  private readonly links = new Map<string, LinkRecord>();
  private readonly keys = new Map<string, SharingKeyRecord>();
  private readonly userShares = new Map<string, UserShareRecord>();

  insertLink(link: LinkRecord): Promise<boolean> {
    if (this.links.has(link.id) || this.userShares.has(link.id)) return Promise.resolve(false);
    this.links.set(link.id, { ...link });
    return Promise.resolve(true);
  }

  getLink(id: string): Promise<LinkRecord | null> {
    const link = this.links.get(id);
    return Promise.resolve(link ? { ...link } : null);
  }

  listLinks(ownerId: string): Promise<LinkRecord[]> {
    return Promise.resolve(
      [...this.links.values()]
        .filter((l) => l.ownerId === ownerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((l) => ({ ...l })),
    );
  }

  countActiveLinks(ownerId: string, now: Date): Promise<number> {
    let n = 0;
    for (const l of this.links.values()) if (l.ownerId === ownerId && isLinkOpen(l, now)) n++;
    return Promise.resolve(n);
  }

  consumeLinkView(
    id: string,
    now: Date,
    check: (link: LinkRecord) => boolean,
  ): Promise<LinkRecord | null> {
    const link = this.links.get(id);
    if (!link) return Promise.resolve(null);
    if (!isLinkOpen(link, now)) {
      link.blob = null;
      return Promise.resolve(null);
    }
    if (!check(link)) return Promise.resolve(null);
    const before = { ...link };
    link.viewCount += 1;
    if (link.viewCount >= link.maxViews) link.blob = null;
    return Promise.resolve(before);
  }

  revokeLink(id: string, ownerId: string, now: Date): Promise<boolean> {
    const link = this.links.get(id);
    if (!link || link.ownerId !== ownerId) return Promise.resolve(false);
    link.revokedAt ??= now;
    link.blob = null;
    return Promise.resolve(true);
  }

  putSharingKey(key: SharingKeyRecord): Promise<void> {
    this.keys.set(key.userId, { ...key, email: key.email.toLowerCase() });
    return Promise.resolve();
  }

  getSharingKeyByUser(userId: string): Promise<SharingKeyRecord | null> {
    const key = this.keys.get(userId);
    return Promise.resolve(key ? { ...key } : null);
  }

  getSharingKeyByEmail(email: string): Promise<SharingKeyRecord | null> {
    const wanted = email.toLowerCase();
    const key = [...this.keys.values()].find((k) => k.email === wanted);
    return Promise.resolve(key ? { ...key } : null);
  }

  insertUserShare(share: UserShareRecord): Promise<boolean> {
    if (this.userShares.has(share.id) || this.links.has(share.id)) return Promise.resolve(false);
    this.userShares.set(share.id, { ...share });
    return Promise.resolve(true);
  }

  listIncoming(recipientId: string, now: Date): Promise<UserShareRecord[]> {
    return Promise.resolve(this.userSharesWhere((s) => s.recipientId === recipientId, now));
  }

  listOutgoing(senderId: string, now: Date): Promise<UserShareRecord[]> {
    return Promise.resolve(this.userSharesWhere((s) => s.senderId === senderId, now));
  }

  deleteUserShare(id: string, userId: string): Promise<boolean> {
    const share = this.userShares.get(id);
    if (!share || (share.senderId !== userId && share.recipientId !== userId)) {
      return Promise.resolve(false);
    }
    this.userShares.delete(id);
    return Promise.resolve(true);
  }

  private userSharesWhere(pred: (s: UserShareRecord) => boolean, now: Date): UserShareRecord[] {
    for (const [id, s] of this.userShares) if (!isLive(s, now)) this.userShares.delete(id);
    return [...this.userShares.values()]
      .filter(pred)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({ ...s }));
  }
}

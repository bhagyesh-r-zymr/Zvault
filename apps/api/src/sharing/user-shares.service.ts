import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateUserShareRequest,
  IncomingUserShare,
  OutgoingUserShare,
  ShareId,
  SharingKeyResponse,
  SharingPublicKey,
} from '@zvault/shared';
import type { SharingUser } from './auth.js';
import { type Clock, SHARE_CLOCK } from './clock.js';
import { SHARE_NOTIFIER, type ShareNotifier } from './share.notifier.js';
import { SHARE_STORE, type ShareStore, type SharingKeyRecord } from './share.store.js';

const toKeyResponse = (k: SharingKeyRecord): SharingKeyResponse => ({
  userId: k.userId,
  email: k.email,
  publicKey: k.publicKey,
});

@Injectable()
export class UserSharesService {
  constructor(
    @Inject(SHARE_STORE) private readonly store: ShareStore,
    @Inject(SHARE_NOTIFIER) private readonly notifier: ShareNotifier,
    @Inject(SHARE_CLOCK) private readonly now: Clock,
  ) {}

  async publishKey(user: SharingUser, publicKey: SharingPublicKey): Promise<SharingKeyResponse> {
    const record = { userId: user.id, email: user.email, publicKey, updatedAt: this.now() };
    await this.store.putSharingKey(record);
    return toKeyResponse(record);
  }

  async myKey(user: SharingUser): Promise<SharingKeyResponse> {
    const key = await this.store.getSharingKeyByUser(user.id);
    if (!key) throw new NotFoundException('No sharing key published yet');
    return toKeyResponse(key);
  }

  async lookupKey(email: string): Promise<SharingKeyResponse> {
    const key = await this.store.getSharingKeyByEmail(email);
    if (!key) throw new NotFoundException('No Zvault user can receive shares at that email');
    return toKeyResponse(key);
  }

  async create(sender: SharingUser, req: CreateUserShareRequest): Promise<OutgoingUserShare> {
    const senderKey = await this.store.getSharingKeyByUser(sender.id);
    if (senderKey?.publicKey !== req.senderPublicKey) {
      throw new ConflictException('Your sharing key does not match the one on file');
    }
    const recipient = await this.store.getSharingKeyByEmail(req.recipientEmail);
    if (!recipient) {
      throw new NotFoundException('No Zvault user can receive shares at that email');
    }
    if (recipient.userId === sender.id) {
      throw new UnprocessableEntityException('You cannot share an item with yourself');
    }
    // The sender encrypted to a key they fetched earlier; refuse if it has since
    // changed so the item is never stored under a key the recipient can't use.
    if (recipient.publicKey !== req.recipientPublicKey) {
      throw new ConflictException("The recipient's sharing key changed; fetch it again");
    }

    const now = this.now();
    const record = {
      id: req.id,
      senderId: sender.id,
      senderEmail: sender.email.toLowerCase(),
      senderPublicKey: senderKey.publicKey,
      recipientId: recipient.userId,
      recipientEmail: recipient.email,
      ephemeralPublicKey: req.ephemeralPublicKey,
      blob: req.blob,
      createdAt: now,
      expiresAt: req.expiresInSeconds
        ? new Date(now.getTime() + req.expiresInSeconds * 1000)
        : null,
    };
    if (!(await this.store.insertUserShare(record))) {
      throw new ConflictException('Share id already in use');
    }
    await this.notifier.shareReceived({
      shareId: record.id,
      senderEmail: record.senderEmail,
      recipientEmail: record.recipientEmail,
    });
    return {
      id: record.id,
      recipient: { userId: record.recipientId, email: record.recipientEmail },
      createdAt: now.toISOString(),
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
  }

  async incoming(user: SharingUser): Promise<IncomingUserShare[]> {
    return (await this.store.listIncoming(user.id, this.now())).map((s) => ({
      id: s.id,
      sender: { userId: s.senderId, email: s.senderEmail, publicKey: s.senderPublicKey },
      ephemeralPublicKey: s.ephemeralPublicKey,
      blob: s.blob,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    }));
  }

  async outgoing(user: SharingUser): Promise<OutgoingUserShare[]> {
    return (await this.store.listOutgoing(user.id, this.now())).map((s) => ({
      id: s.id,
      recipient: { userId: s.recipientId, email: s.recipientEmail },
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    }));
  }

  /** The sender revokes, or the recipient dismisses. */
  async remove(user: SharingUser, id: ShareId): Promise<void> {
    if (!(await this.store.deleteUserShare(id, user.id))) throw new NotFoundException();
  }
}

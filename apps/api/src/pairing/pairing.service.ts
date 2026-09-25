import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PAIRING_LIMITS,
  type ClaimPairingRequest,
  type CreatePairingResponse,
  type PairingGrant,
  type PairingResultResponse,
  type PairingView,
} from '@zvault/shared';
import { SessionStore } from '../devices/session.store.js';
import { type Clock, PAIRING_CLOCK } from './clock.js';
import { PairingStore, type PairingRecord } from './pairing.store.js';

/** One account can have this many QR codes on screen at once. */
export const MAX_LIVE_PAIRINGS_PER_USER = 5;

const hashClaim = (token: string) => createHash('sha256').update(token, 'utf8').digest();

@Injectable()
export class PairingService {
  constructor(
    private readonly store: PairingStore,
    private readonly sessions: SessionStore,
    @Inject(PAIRING_CLOCK) private readonly now: Clock,
  ) {}

  create(userId: string, claimToken: string): CreatePairingResponse {
    const now = this.now();
    if (this.store.countLive(userId, now) >= MAX_LIVE_PAIRINGS_PER_USER) {
      throw new UnprocessableEntityException(
        'Too many phones waiting to be added. Try again soon.',
      );
    }
    const record: PairingRecord = {
      id: randomUUID(),
      userId,
      claimHash: hashClaim(claimToken),
      status: 'waiting',
      expiresAt: new Date(now.getTime() + PAIRING_LIMITS.ttlSeconds * 1000),
      device: null,
      publicKey: null,
      grant: null,
      sessionToken: null,
      sessionExpiresAt: null,
    };
    this.store.insert(record);
    return { id: record.id, expiresAt: record.expiresAt.toISOString() };
  }

  /** The phone's first call. An unknown id and a wrong token look the same. */
  claim(id: string, req: ClaimPairingRequest): void {
    const record = this.withToken(id, req.claimToken);
    if (record.status !== 'waiting') {
      throw new ConflictException('This QR code has already been used. Show a new one.');
    }
    record.status = 'claimed';
    record.device = req.device;
    record.publicKey = req.publicKey;
  }

  view(userId: string, id: string): PairingView {
    const record = this.owned(userId, id);
    return {
      id: record.id,
      status: record.status,
      expiresAt: record.expiresAt.toISOString(),
      device: record.device,
      publicKey: record.publicKey,
    };
  }

  /** Issues the phone its own session and holds the sealed keys for it to collect. */
  async approve(userId: string, id: string, grant: PairingGrant): Promise<void> {
    const record = this.owned(userId, id);
    if (record.status !== 'claimed' || !record.device) {
      throw new ConflictException('No phone is waiting on this QR code.');
    }
    const { session, token } = await this.sessions.issue(userId, record.device, this.now());
    record.status = 'approved';
    record.grant = grant;
    record.sessionToken = token;
    record.sessionExpiresAt = session.expiresAt;
  }

  deny(userId: string, id: string): void {
    const record = this.owned(userId, id);
    if (record.status === 'approved') {
      throw new ConflictException('This phone was already added. Remove it from Devices instead.');
    }
    record.status = 'denied';
    record.grant = null;
  }

  /** The phone polls this. A decided pairing is answered once and then forgotten. */
  result(id: string, claimToken: string): PairingResultResponse {
    const record = this.withToken(id, claimToken);
    switch (record.status) {
      case 'waiting':
      case 'claimed':
        return { status: 'waiting' };
      case 'denied':
        this.store.delete(id);
        return { status: 'denied' };
      case 'approved': {
        this.store.delete(id);
        const { grant, sessionToken, sessionExpiresAt } = record;
        if (!grant || !sessionToken || !sessionExpiresAt) throw new GoneException();
        return {
          status: 'approved',
          sessionToken,
          expiresAt: sessionExpiresAt.toISOString(),
          grant,
        };
      }
    }
  }

  private owned(userId: string, id: string): PairingRecord {
    const record = this.store.get(id, this.now());
    if (!record || record.userId !== userId) throw new NotFoundException();
    return record;
  }

  private withToken(id: string, claimToken: string): PairingRecord {
    const record = this.store.get(id, this.now());
    const presented = hashClaim(claimToken);
    if (!record || !timingSafeEqual(presented, record.claimHash)) {
      throw new NotFoundException('This QR code has expired. Show a new one.');
    }
    return record;
  }
}

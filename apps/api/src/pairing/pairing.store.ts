import { Injectable } from '@nestjs/common';
import type { DeviceInfo, PairingGrant, SharingPublicKey } from '@zvault/shared';

export interface PairingRecord {
  id: string;
  /** The account whose signed-in device created the pairing. */
  userId: string;
  /** SHA-256 of the claim token; the token itself is never stored. */
  claimHash: Buffer;
  status: 'waiting' | 'claimed' | 'approved' | 'denied';
  expiresAt: Date;
  device: DeviceInfo | null;
  publicKey: SharingPublicKey | null;
  /** Set on approval and dropped once the phone collects it. */
  grant: PairingGrant | null;
  sessionToken: string | null;
  sessionExpiresAt: Date | null;
}

/**
 * Pairings live for a few minutes, so they are kept in memory: a restart only
 * means showing a fresh QR code.
 */
@Injectable()
export class PairingStore {
  private readonly byId = new Map<string, PairingRecord>();

  insert(record: PairingRecord): void {
    this.byId.set(record.id, record);
  }

  /** The live pairing with this id, or null. Expired pairings are dropped here. */
  get(id: string, now: Date): PairingRecord | null {
    const record = this.byId.get(id);
    if (!record) return null;
    if (record.expiresAt.getTime() <= now.getTime()) {
      this.byId.delete(id);
      return null;
    }
    return record;
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  countLive(userId: string, now: Date): number {
    let n = 0;
    for (const record of [...this.byId.values()]) {
      if (record.expiresAt.getTime() <= now.getTime()) this.byId.delete(record.id);
      else if (record.userId === userId) n++;
    }
    return n;
  }
}

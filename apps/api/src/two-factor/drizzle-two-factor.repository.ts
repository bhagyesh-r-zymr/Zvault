import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import { twoFactor } from '../db/schema.js';
import type { TwoFactorRecord, TwoFactorRepository } from './two-factor.repository.js';

type Row = typeof twoFactor.$inferSelect;

const toRecord = (r: Row): TwoFactorRecord => ({
  userId: r.accountId,
  totpSecret: r.totpSecret,
  enabledAt: r.enabledAt,
  lastUsedStep: r.lastUsedStep,
  pendingSecret: r.pendingSecret,
  pendingExpiresAt: r.pendingExpiresAt,
  recoveryCodeHashes: r.recoveryCodeHashes,
  failedAttempts: r.failedAttempts,
  lockedUntil: r.lockedUntil,
  version: r.version,
});

/** 2FA state in the Postgres `two_factor` table, one row per account. */
@Injectable()
export class DrizzleTwoFactorRepository implements TwoFactorRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async find(userId: string): Promise<TwoFactorRecord | null> {
    const [row] = await this.db
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.accountId, userId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async update(next: TwoFactorRecord, expectedVersion: number): Promise<boolean> {
    const values = {
      totpSecret: next.totpSecret,
      enabledAt: next.enabledAt,
      lastUsedStep: next.lastUsedStep,
      pendingSecret: next.pendingSecret,
      pendingExpiresAt: next.pendingExpiresAt,
      recoveryCodeHashes: next.recoveryCodeHashes,
      failedAttempts: next.failedAttempts,
      lockedUntil: next.lockedUntil,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    };
    if (expectedVersion === 0) {
      // First write: loses cleanly to a concurrent first write.
      const inserted = await this.db
        .insert(twoFactor)
        .values({ accountId: next.userId, ...values })
        .onConflictDoNothing()
        .returning({ accountId: twoFactor.accountId });
      return inserted.length === 1;
    }
    const updated = await this.db
      .update(twoFactor)
      .set(values)
      .where(and(eq(twoFactor.accountId, next.userId), eq(twoFactor.version, expectedVersion)))
      .returning({ accountId: twoFactor.accountId });
    return updated.length === 1;
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(twoFactor).where(eq(twoFactor.accountId, userId));
  }
}

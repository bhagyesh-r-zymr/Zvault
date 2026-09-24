import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DeviceInfo } from '@zvault/shared';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import { sessions } from '../db/schema.js';
import {
  hashToken,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SessionStore,
  TOUCH_GRANULARITY_MS,
  type IssuedSession,
  type Session,
} from './session.store.js';

type Row = typeof sessions.$inferSelect;

const toSession = (r: Row): Session => ({
  id: r.id,
  userId: r.accountId,
  device: r.device,
  tokenHash: r.tokenHash.toString('base64url'),
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
  expiresAt: r.expiresAt,
});

const hashBytes = (token: string): Buffer => Buffer.from(hashToken(token), 'base64url');

/** Not revoked, within the absolute lifetime, and used within the idle window. */
const live = (now: Date) =>
  and(
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, now),
    gt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_IDLE_TTL_MS)),
  );

/** Sessions in the Postgres `sessions` table. Revoked rows are kept for audit. */
@Injectable()
export class DrizzleSessionStore extends SessionStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {
    super();
  }

  async issue(userId: string, device: DeviceInfo, now = new Date()): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(sessions)
      .values({
        accountId: userId,
        device,
        tokenHash: hashBytes(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
      })
      .returning();
    return { session: toSession(row!), token };
  }

  async authenticate(token: string, now = new Date()): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashBytes(token)), live(now)))
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_GRANULARITY_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id));
      row.lastSeenAt = now;
    }
    return toSession(row);
  }

  async listForUser(userId: string, now = new Date()): Promise<Session[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.accountId, userId), live(now)));
    return rows.map(toSession);
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.accountId, userId), isNull(sessions.revokedAt)),
      )
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  async revokeAllExcept(userId: string, keepSessionId: string): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.accountId, userId),
          ne(sessions.id, keepSessionId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return revoked.length;
  }
}

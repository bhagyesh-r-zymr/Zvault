import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, sessions } from '../db/schema.js';
import { hashToken, minutesFromNow, randomToken } from './tokens.js';

export interface AuthenticatedSession {
  sessionId: string;
  accountId: string;
  email: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(accountId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = minutesFromNow(this.env.SESSION_TTL_MINUTES);
    await this.db.insert(sessions).values({ accountId, tokenHash: hashToken(token), expiresAt });
    return { token, expiresAt };
  }

  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        accountId: sessions.accountId,
        email: accounts.email,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return null;
    await this.db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.sessionId));
    return row;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }
}

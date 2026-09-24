import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DATABASE, type Database } from '../db/database.js';
import { accounts } from '../db/schema.js';
import { SessionStore } from '../devices/session.store.js';
import type {
  AuthenticatedUser,
  AuthenticatedUserResolver,
} from '../two-factor/authenticated-user.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** Resolves the 2FA endpoints' user from the request's session token. */
@Injectable()
export class SessionUserResolver implements AuthenticatedUserResolver {
  constructor(
    private readonly sessions: SessionStore,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async resolve(req: Request): Promise<AuthenticatedUser | null> {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? await this.sessions.authenticate(token) : null;
    if (!session) return null;
    const [account] = await this.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, session.userId))
      .limit(1);
    return account ? { id: session.userId, email: account.email } : null;
  }
}

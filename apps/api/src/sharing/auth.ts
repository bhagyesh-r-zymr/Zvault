import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DATABASE, type Database } from '../db/database.js';
import { accounts } from '../db/schema.js';
import { SessionStore } from '../devices/session.store.js';

/**
 * The signed-in account, attached to the request as `request.user`. Sharing
 * only needs the stable id and the verified email.
 */
export interface SharingUser {
  id: string;
  email: string;
}

type RequestWithUser = Request & { user?: SharingUser };

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/**
 * Requires a live session (`Authorization: Bearer <token>`) and sets
 * `request.user` to its account. A `request.user` already set by middleware
 * in front of the app (the sharing tests stub one) is kept as is.
 */
@Injectable()
export class RequireUser implements CanActivate {
  constructor(
    private readonly sessions: SessionStore,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (req.user?.id && req.user.email) return true;
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? await this.sessions.authenticate(token) : null;
    if (!session) throw new UnauthorizedException();
    const [account] = await this.db
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, session.userId))
      .limit(1);
    if (!account) throw new UnauthorizedException();
    req.user = account;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<RequestWithUser>().user;
  if (!user) throw new UnauthorizedException();
  return user;
});

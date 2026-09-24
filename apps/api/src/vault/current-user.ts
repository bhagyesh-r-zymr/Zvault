import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Session } from '../devices/session.store.js';

/** The signed-in account a request acts for. */
export interface AuthenticatedUser {
  id: string;
}

/** The account whose session authenticated this request. Use only behind `SessionGuard`. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const session = ctx
      .switchToHttp()
      .getRequest<Request & { zvaultSession?: Session }>().zvaultSession;
    if (!session) throw new UnauthorizedException();
    return { id: session.userId };
  },
);

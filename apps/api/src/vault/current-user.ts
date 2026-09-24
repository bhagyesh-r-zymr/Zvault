import {
  createParamDecorator,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * The authenticated account, attached to the request by the auth layer once a
 * session token has been verified. Vault routes only read it.
 */
export interface AuthenticatedUser {
  id: string;
}

type RequestWithUser = Request & { user?: AuthenticatedUser };

function userOf(ctx: ExecutionContext): AuthenticatedUser | undefined {
  const user = ctx.switchToHttp().getRequest<RequestWithUser>().user;
  return typeof user?.id === 'string' && user.id.length > 0 ? user : undefined;
}

/** Rejects requests that the auth layer has not authenticated. */
export class RequireUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (!userOf(ctx)) throw new UnauthorizedException();
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const user = userOf(ctx);
  if (!user) throw new UnauthorizedException();
  return user;
});

import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/** The signed-in user, as established by the login/session layer. */
export interface AuthenticatedUser {
  id: string;
  /** Shown in the authenticator app next to the issuer. */
  email: string;
}

/**
 * Port to the session layer, which the login feature owns. It returns the
 * user behind a request's session, or null when there is none. Until a real
 * resolver is wired in, every 2FA management request is rejected.
 */
export interface AuthenticatedUserResolver {
  resolve(req: Request): Promise<AuthenticatedUser | null>;
}

export const AUTHENTICATED_USER_RESOLVER = Symbol('AUTHENTICATED_USER_RESOLVER');

export class NoSessionResolver implements AuthenticatedUserResolver {
  resolve(): Promise<AuthenticatedUser | null> {
    return Promise.resolve(null);
  }
}

type RequestWithUser = Request & { zvaultUser?: AuthenticatedUser };

@Injectable()
export class AuthenticatedUserGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATED_USER_RESOLVER) private readonly resolver: AuthenticatedUserResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await this.resolver.resolve(req);
    if (!user) throw new UnauthorizedException();
    req.zvaultUser = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<RequestWithUser>().zvaultUser;
  if (!user) throw new UnauthorizedException();
  return user;
});

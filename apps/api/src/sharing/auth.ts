import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * The signed-in account, as the auth module attaches it to the request
 * (`request.user`). Sharing only needs the stable id and the verified email.
 */
export interface SharingUser {
  id: string;
  email: string;
}

type RequestWithUser = Request & { user?: SharingUser };

/** Rejects requests that the auth layer did not authenticate. */
@Injectable()
export class RequireUser implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user?.id || !req.user.email) throw new UnauthorizedException();
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<RequestWithUser>().user;
  if (!user) throw new UnauthorizedException();
  return user;
});

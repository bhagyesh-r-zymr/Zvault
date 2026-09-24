import {
  createParamDecorator,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService, type AuthenticatedSession } from './session.service.js';

type AuthedRequest = Request & { session?: AuthenticatedSession };

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** Requires `Authorization: Bearer <session token>`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? await this.sessions.authenticate(token) : null;
    if (!session) throw new UnauthorizedException('Sign in to continue.');
    req.session = session;
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthenticatedSession =>
    context.switchToHttp().getRequest<AuthedRequest>().session!,
);

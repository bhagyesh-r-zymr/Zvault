import {
  createParamDecorator,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionStore, type Session } from './session.store.js';

type AuthedRequest = Request & { zvaultSession?: Session };

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** Requires a live session token in `Authorization: Bearer <token>`. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? await this.sessions.authenticate(token) : null;
    if (!session) throw new UnauthorizedException();
    req.zvaultSession = session;
    return true;
  }
}

/** The session that authenticated this request. Use only behind `SessionGuard`. */
export const CurrentSession = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const session = context.switchToHttp().getRequest<AuthedRequest>().zvaultSession;
  if (!session) throw new UnauthorizedException();
  return session;
});

import {
  createParamDecorator,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { TOKEN_BEARER } from '@zvault/shared';
import type { Request } from 'express';
import { TokensService, type ActiveToken } from './tokens.service.js';

type TokenRequest = Request & { zvaultToken?: ActiveToken };

/** Requires a working access token in `Authorization: Bearer <id>.<auth key>`. */
@Injectable()
export class TokenGuard implements CanActivate {
  constructor(private readonly tokens: TokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TokenRequest>();
    const m = TOKEN_BEARER.exec(req.headers.authorization ?? '');
    if (!m) throw new UnauthorizedException({ error: 'invalid_token' });
    req.zvaultToken = await this.tokens.authenticate(m[1]!, m[2]!);
    return true;
  }
}

/** The token that authenticated this request. Use only behind `TokenGuard`. */
export const CurrentToken = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const token = context.switchToHttp().getRequest<TokenRequest>().zvaultToken;
  if (!token) throw new UnauthorizedException();
  return token;
});

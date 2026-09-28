import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateTokenRequest,
  RecordId,
  SyncProjectQuery,
  type ListTokensResponse,
  type TokenChangesResponse,
  type TokenSessionResponse,
  type TokenView,
} from '@zvault/shared';
import type { z } from 'zod';
import { SessionGuard } from '../devices/session.guard.js';
import { CurrentUser, type AuthenticatedUser } from '../vault/current-user.js';
import { ZodPipe } from '../vault/zod.pipe.js';
import { CurrentToken, TokenGuard } from './token.guard.js';
import { TokensService, type ActiveToken } from './tokens.service.js';

const Id = new ZodPipe(RecordId);

/** Issuing, listing and revoking a project's access tokens, from the app. */
@Controller('projects/:projectId/tokens')
@UseGuards(SessionGuard)
export class ProjectTokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
  ): Promise<ListTokensResponse> {
    return { tokens: await this.tokens.list(user, projectId) };
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Body(new ZodPipe(CreateTokenRequest)) body: CreateTokenRequest,
  ): Promise<TokenView> {
    return this.tokens.create(user, projectId, body);
  }

  @Delete(':tokenId')
  @HttpCode(204)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('tokenId', Id) tokenId: string,
  ): Promise<void> {
    return this.tokens.revoke(user, projectId, tokenId);
  }
}

/** What `zv` calls with `ZVAULT_TOKEN`: the token's keys, then the project's ciphertext. */
@Controller('token')
@UseGuards(TokenGuard)
export class TokenController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  session(@CurrentToken() token: ActiveToken): Promise<TokenSessionResponse> {
    return this.tokens.session(token);
  }

  @Get('changes')
  changes(
    @CurrentToken() token: ActiveToken,
    @Query(new ZodPipe(SyncProjectQuery)) query: z.infer<typeof SyncProjectQuery>,
  ): Promise<TokenChangesResponse> {
    return this.tokens.changes(token, query.since, query.limit);
  }
}

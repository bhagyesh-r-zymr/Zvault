import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CheckShareLinkRequest,
  CreateShareLinkRequest,
  CreateUserShareRequest,
  OpenShareLinkRequest,
  PublishSharingKeyRequest,
  RequestShareCodeRequest,
  ShareId,
  type CheckShareLinkResponse,
  type CreateShareLinkResponse,
  type OpenShareLinkResponse,
  type OutgoingUserShare,
  type ShareLinkList,
  type SharingKeyResponse,
  type UserShareList,
} from '@zvault/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { CurrentUser, RequireUser, type SharingUser } from './auth.js';
import { ShareLinksService } from './share-links.service.js';
import { UserSharesService } from './user-shares.service.js';

const IdParam = new ZodPipe(ShareId);
const EmailQuery = new ZodPipe(z.email().max(254));

/** Anonymous endpoints the recipient page calls with the token from the link. */
@Controller('shares/links')
export class PublicShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @Post(':id/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  check(
    @Param('id', IdParam) id: ShareId,
    @Body(new ZodPipe(CheckShareLinkRequest)) body: CheckShareLinkRequest,
  ): Promise<CheckShareLinkResponse> {
    return this.links.check(id, body.accessToken);
  }

  @Post(':id/code')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  // Each call can send an email; per-link limits apply on top of this.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestCode(
    @Param('id', IdParam) id: ShareId,
    @Body(new ZodPipe(RequestShareCodeRequest)) body: RequestShareCodeRequest,
  ): Promise<void> {
    return this.links.requestCode(id, body);
  }

  @Post(':id/open')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  // Tight limit: each call needs the 256-bit link key, but also counts a view.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  open(
    @Param('id', IdParam) id: ShareId,
    @Body(new ZodPipe(OpenShareLinkRequest)) body: OpenShareLinkRequest,
  ): Promise<OpenShareLinkResponse> {
    return this.links.open(id, body);
  }
}

@Controller('shares')
@UseGuards(RequireUser)
export class SharingController {
  constructor(
    private readonly links: ShareLinksService,
    private readonly userShares: UserSharesService,
  ) {}

  @Post('links')
  createLink(
    @CurrentUser() user: SharingUser,
    @Body(new ZodPipe(CreateShareLinkRequest)) body: CreateShareLinkRequest,
  ): Promise<CreateShareLinkResponse> {
    return this.links.create(user.id, body);
  }

  @Get('links')
  @Header('Cache-Control', 'no-store')
  async listLinks(@CurrentUser() user: SharingUser): Promise<ShareLinkList> {
    return { links: await this.links.list(user.id) };
  }

  @Delete('links/:id')
  @HttpCode(204)
  revokeLink(@CurrentUser() user: SharingUser, @Param('id', IdParam) id: ShareId): Promise<void> {
    return this.links.revoke(user.id, id);
  }

  @Put('keys/me')
  publishKey(
    @CurrentUser() user: SharingUser,
    @Body(new ZodPipe(PublishSharingKeyRequest)) body: PublishSharingKeyRequest,
  ): Promise<SharingKeyResponse> {
    return this.userShares.publishKey(user, body.publicKey);
  }

  @Get('keys/me')
  myKey(@CurrentUser() user: SharingUser): Promise<SharingKeyResponse> {
    return this.userShares.myKey(user);
  }

  @Get('keys')
  // Lookups reveal whether an email has an account, so keep them slow.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  lookupKey(@Query('email', EmailQuery) email: string): Promise<SharingKeyResponse> {
    return this.userShares.lookupKey(email);
  }

  @Post('users')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  shareWithUser(
    @CurrentUser() user: SharingUser,
    @Body(new ZodPipe(CreateUserShareRequest)) body: CreateUserShareRequest,
  ): Promise<OutgoingUserShare> {
    return this.userShares.create(user, body);
  }

  @Get('users')
  @Header('Cache-Control', 'no-store')
  async listUserShares(@CurrentUser() user: SharingUser): Promise<UserShareList> {
    const [incoming, outgoing] = await Promise.all([
      this.userShares.incoming(user),
      this.userShares.outgoing(user),
    ]);
    return { incoming, outgoing };
  }

  @Delete('users/:id')
  @HttpCode(204)
  removeUserShare(
    @CurrentUser() user: SharingUser,
    @Param('id', IdParam) id: ShareId,
  ): Promise<void> {
    return this.userShares.remove(user, id);
  }
}

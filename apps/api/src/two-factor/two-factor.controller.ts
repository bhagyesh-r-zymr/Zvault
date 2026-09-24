import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  TotpConfirmRequest,
  TwoFactorProof,
  type RecoveryCodesResponse,
  type TotpSetupResponse,
  type TwoFactorStatusResponse,
} from '@zvault/shared';
import type { z } from 'zod';
import {
  AuthenticatedUserGuard,
  CurrentUser,
  type AuthenticatedUser,
} from './authenticated-user.js';
import { TwoFactorService } from './two-factor.service.js';

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({ error: 'invalid_request', issues: result.error.issues });
  }
  return result.data;
}

/** 2FA management for the signed-in user. Responses carry secrets, so none are cached. */
@Controller('2fa')
@UseGuards(AuthenticatedUserGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() user: AuthenticatedUser): Promise<TwoFactorStatusResponse> {
    return this.twoFactor.status(user.id);
  }

  @Post('totp/setup')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  setup(@CurrentUser() user: AuthenticatedUser): Promise<TotpSetupResponse> {
    return this.twoFactor.beginSetup(user.id, user.email);
  }

  @Post('totp/confirm')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<RecoveryCodesResponse> {
    return this.twoFactor.confirmSetup(user.id, parse(TotpConfirmRequest, body).code);
  }

  @Post('recovery-codes')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<RecoveryCodesResponse> {
    return this.twoFactor.regenerateRecoveryCodes(user.id, parse(TwoFactorProof, body));
  }

  @Post('disable')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  disable(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<void> {
    return this.twoFactor.disable(user.id, parse(TwoFactorProof, body));
  }
}

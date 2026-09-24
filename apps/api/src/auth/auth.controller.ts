import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  LoginFinishRequest,
  LoginStartRequest,
  SignupCompleteRequest,
  SignupStartRequest,
  SignupVerifyRequest,
  type LoginFinishResponse,
  type LoginStartResponse,
  type SessionResponse,
  type SignupCompleteResponse,
  type SignupVerifyResponse,
} from '@zvault/shared';
import type { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthGuard, CurrentSession } from './auth.guard.js';
import { LoginService } from './login.service.js';
import type { AuthenticatedSession } from './session.service.js';
import { SessionService } from './session.service.js';
import { SignupService } from './signup.service.js';

@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly signup: SignupService,
    private readonly login: LoginService,
    private readonly sessions: SessionService,
  ) {}

  /** Emails a verification code. Always 202, registered or not. */
  @Post('signup/start')
  @HttpCode(202)
  async signupStart(
    @Body(new ZodPipe(SignupStartRequest)) body: z.output<typeof SignupStartRequest>,
  ): Promise<void> {
    await this.signup.start(body.email);
  }

  @Post('signup/verify')
  @HttpCode(200)
  signupVerify(
    @Body(new ZodPipe(SignupVerifyRequest)) body: z.output<typeof SignupVerifyRequest>,
  ): Promise<SignupVerifyResponse> {
    return this.signup.verify(body.email, body.code);
  }

  @Post('signup/complete')
  @HttpCode(201)
  signupComplete(
    @Body(new ZodPipe(SignupCompleteRequest)) body: z.output<typeof SignupCompleteRequest>,
  ): Promise<SignupCompleteResponse> {
    return this.signup.complete(body);
  }

  @Post('login/start')
  @HttpCode(200)
  loginStart(
    @Body(new ZodPipe(LoginStartRequest)) body: z.output<typeof LoginStartRequest>,
  ): Promise<LoginStartResponse> {
    return this.login.start(body.email);
  }

  @Post('login/finish')
  @HttpCode(200)
  loginFinish(
    @Body(new ZodPipe(LoginFinishRequest)) body: z.output<typeof LoginFinishRequest>,
  ): Promise<LoginFinishResponse> {
    return this.login.finish(body);
  }

  @Get('session')
  @UseGuards(AuthGuard)
  session(@CurrentSession() session: AuthenticatedSession): SessionResponse {
    return {
      accountId: session.accountId,
      email: session.email,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@CurrentSession() session: AuthenticatedSession): Promise<void> {
    await this.sessions.revoke(session.sessionId);
  }
}

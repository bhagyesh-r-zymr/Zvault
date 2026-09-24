import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
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
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE, type Database } from '../db/database.js';
import { accounts } from '../db/schema.js';
import { CurrentSession, SessionGuard } from '../devices/session.guard.js';
import { SessionStore, type Session } from '../devices/session.store.js';
import { LoginService } from './login.service.js';
import { SignupService } from './signup.service.js';

@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly signup: SignupService,
    private readonly login: LoginService,
    private readonly sessions: SessionStore,
    @Inject(DATABASE) private readonly db: Database,
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
  @UseGuards(SessionGuard)
  async session(@CurrentSession() session: Session): Promise<SessionResponse> {
    const [account] = await this.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, session.userId))
      .limit(1);
    if (!account) throw new UnauthorizedException();
    return {
      accountId: session.userId,
      email: account.email,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@CurrentSession() session: Session): Promise<void> {
    await this.sessions.revoke(session.userId, session.id);
  }
}

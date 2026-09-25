import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AccountRecoverySetupRequest,
  LoginFinishRequest,
  LoginStartRequest,
  LoginTwoFactorRequest,
  PasswordChangeRequest,
  RecoverCompleteRequest,
  RecoverStartRequest,
  RecoverVerifyRequest,
  SignupCompleteRequest,
  SignupStartRequest,
  SignupVerifyRequest,
  type AccountRecoveryStatus,
  type LoginFinishResponse,
  type LoginStartResponse,
  type LoginTwoFactorResponse,
  type ReauthenticatedResponse,
  type RecoverCompleteResponse,
  type RecoverVerifyResponse,
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
import { RecoveryService } from './recovery.service.js';
import { SignupService } from './signup.service.js';

@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly signup: SignupService,
    private readonly login: LoginService,
    private readonly recovery: RecoveryService,
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

  /** Completes a login that `login/finish` answered with `twoFactorRequired`. */
  @Post('login/two-factor')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  loginTwoFactor(
    @Body(new ZodPipe(LoginTwoFactorRequest)) body: z.output<typeof LoginTwoFactorRequest>,
  ): Promise<LoginTwoFactorResponse> {
    return this.login.finishTwoFactor(body.twoFactorToken, body.proof);
  }

  /**
   * Changes the master password. Needs a fresh SRP proof of the current one,
   * so a stolen session token alone can't. Signs out every other session.
   */
  @Post('password')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  changePassword(
    @CurrentSession() session: Session,
    @Body(new ZodPipe(PasswordChangeRequest)) body: z.output<typeof PasswordChangeRequest>,
  ): Promise<ReauthenticatedResponse> {
    return this.recovery.changePassword(session.userId, session.id, body);
  }

  @Get('recovery')
  @UseGuards(SessionGuard)
  recoveryStatus(@CurrentSession() session: Session): Promise<AccountRecoveryStatus> {
    return this.recovery.status(session.userId);
  }

  /** Sets up or replaces the recovery code. Needs a fresh proof of the master password. */
  @Put('recovery')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  setUpRecovery(
    @CurrentSession() session: Session,
    @Body(new ZodPipe(AccountRecoverySetupRequest))
    body: z.output<typeof AccountRecoverySetupRequest>,
  ): Promise<ReauthenticatedResponse> {
    return this.recovery.setUp(session.userId, body);
  }

  /** Emails a recovery code. Always 202, whatever the address. */
  @Post('recover/start')
  @HttpCode(202)
  async recoverStart(
    @Body(new ZodPipe(RecoverStartRequest)) body: z.output<typeof RecoverStartRequest>,
  ): Promise<void> {
    await this.recovery.start(body.email);
  }

  @Post('recover/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  recoverVerify(
    @Body(new ZodPipe(RecoverVerifyRequest)) body: z.output<typeof RecoverVerifyRequest>,
  ): Promise<RecoverVerifyResponse> {
    return this.recovery.verify(body.email, body.code, body.recoveryAuth);
  }

  @Post('recover/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  recoverComplete(
    @Body(new ZodPipe(RecoverCompleteRequest)) body: z.output<typeof RecoverCompleteRequest>,
  ): Promise<RecoverCompleteResponse> {
    return this.recovery.complete(body);
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

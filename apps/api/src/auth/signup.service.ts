import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import type { SignupCompleteRequest, SignupVerifyResponse } from '@zvault/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, emailVerifications } from '../db/schema.js';
import { Mailer } from '../mail/mailer.js';
import { alreadyRegisteredEmail, verificationCodeEmail } from '../mail/templates.js';
import { isValidVerifier } from './srp.js';
import { hashToken, hmac, minutesFromNow, randomToken } from './tokens.js';

export const CODE_TTL_MINUTES = 15;
export const SIGNUP_TOKEN_TTL_MINUTES = 30;
export const MAX_CODE_ATTEMPTS = 5;
/** Per email: at most one code a minute and five an hour. */
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_CODES_PER_HOUR = 5;

const INVALID_CODE = 'That code is incorrect or has expired. Request a new one and try again.';

@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Emails a six-digit code. Responds the same way whether or not the address
   * is registered; a registered address gets a "you already have an account"
   * email instead of a code.
   */
  async start(email: string): Promise<void> {
    const now = new Date();
    const [existing] = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const issued = await this.db.transaction(async (tx) => {
      // Serialize per address so parallel requests can't each pass the rate
      // check and open several live codes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);
      const recent = await tx
        .select({ createdAt: emailVerifications.createdAt })
        .from(emailVerifications)
        .where(
          and(
            eq(emailVerifications.email, email),
            gt(emailVerifications.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        )
        .orderBy(desc(emailVerifications.createdAt));
      const last = recent[0]?.createdAt;
      if (
        recent.length >= MAX_CODES_PER_HOUR ||
        (last && now.getTime() - last.getTime() < RESEND_COOLDOWN_MS)
      ) {
        return false;
      }

      await tx
        .update(emailVerifications)
        .set({ closedAt: now })
        .where(
          and(
            eq(emailVerifications.email, email),
            isNull(emailVerifications.verifiedAt),
            isNull(emailVerifications.closedAt),
          ),
        );
      // Registered addresses still get a (never-valid) row, so the rate
      // limit behaves the same for both.
      await tx.insert(emailVerifications).values({
        email,
        codeHash: existing ? randomBytes(32) : this.codeHash(email, code),
        expiresAt: minutesFromNow(CODE_TTL_MINUTES, now),
        closedAt: existing ? now : null,
      });
      return true;
    });
    if (!issued) return;

    const message = existing
      ? alreadyRegisteredEmail(email)
      : verificationCodeEmail(email, code, CODE_TTL_MINUTES);
    try {
      await this.mailer.send(message);
    } catch (err) {
      this.logger.error(`Could not send email: ${String(err)}`);
      throw new ServiceUnavailableException('Could not send the email. Try again shortly.');
    }
  }

  /** Checks a code and exchanges it for a single-use sign-up token. */
  async verify(email: string, code: string): Promise<SignupVerifyResponse> {
    const now = new Date();
    const [pending] = await this.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, email),
          isNull(emailVerifications.verifiedAt),
          isNull(emailVerifications.closedAt),
          gt(emailVerifications.expiresAt, now),
        ),
      )
      .orderBy(desc(emailVerifications.createdAt))
      .limit(1);
    if (!pending) throw new BadRequestException(INVALID_CODE);

    if (!timingSafeEqual(pending.codeHash, this.codeHash(email, code))) {
      await this.db
        .update(emailVerifications)
        .set({
          attempts: sql`${emailVerifications.attempts} + 1`,
          closedAt: sql`case when ${emailVerifications.attempts} + 1 >= ${MAX_CODE_ATTEMPTS} then now() else ${emailVerifications.closedAt} end`,
        })
        .where(eq(emailVerifications.id, pending.id));
      throw new BadRequestException(INVALID_CODE);
    }

    const signupToken = randomToken();
    const expiresAt = minutesFromNow(SIGNUP_TOKEN_TTL_MINUTES, now);
    const [verified] = await this.db
      .update(emailVerifications)
      .set({ verifiedAt: now, tokenHash: hashToken(signupToken), tokenExpiresAt: expiresAt })
      .where(
        and(
          eq(emailVerifications.id, pending.id),
          isNull(emailVerifications.verifiedAt),
          isNull(emailVerifications.closedAt),
        ),
      )
      .returning({ id: emailVerifications.id });
    if (!verified) throw new BadRequestException(INVALID_CODE);

    return {
      signupToken: signupToken as SignupVerifyResponse['signupToken'],
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Creates the account from client-derived material. Spends the sign-up token. */
  async complete(req: z.output<typeof SignupCompleteRequest>): Promise<{ accountId: string }> {
    const verifier = Buffer.from(req.srpVerifier, 'base64url');
    if (!isValidVerifier(verifier)) throw new BadRequestException('Invalid SRP verifier');

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [claim] = await tx
        .update(emailVerifications)
        .set({ tokenUsedAt: now })
        .where(
          and(
            eq(emailVerifications.tokenHash, hashToken(req.signupToken)),
            isNull(emailVerifications.tokenUsedAt),
            gt(emailVerifications.tokenExpiresAt, now),
          ),
        )
        .returning({ email: emailVerifications.email });
      if (!claim) {
        throw new BadRequestException('This sign-up has expired. Verify your email again.');
      }

      const [account] = await tx
        .insert(accounts)
        .values({
          email: claim.email,
          secretKeyId: req.secretKeyId,
          kdf: req.kdf,
          srpVerifier: verifier,
          encryptedKeyset: req.encryptedKeyset,
        })
        .onConflictDoNothing({ target: accounts.email })
        .returning({ id: accounts.id });
      if (!account) throw new ConflictException('An account with this email already exists.');
      return { accountId: account.id };
    });
  }

  private codeHash(email: string, code: string): Buffer {
    return hmac(this.env.SERVER_SECRET, 'signup-code', email, code);
  }
}

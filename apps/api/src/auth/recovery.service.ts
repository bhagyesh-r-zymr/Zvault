import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AccountRecoverySetupRequest,
  AccountRecoveryStatus,
  PasswordChangeRequest,
  ReauthenticatedResponse,
  RecoverCompleteRequest,
  RecoverCompleteResponse,
  RecoverVerifyResponse,
} from '@zvault/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import {
  accountRecoveries,
  accounts,
  loginTwoFactorChallenges,
  srpChallenges,
} from '../db/schema.js';
import { SessionStore } from '../devices/session.store.js';
import { Mailer, type MailMessage } from '../mail/mailer.js';
import {
  accountRecoveredEmail,
  passwordChangedEmail,
  recoveryCodeEmail,
  recoveryCodeSetEmail,
  recoveryUnavailableEmail,
} from '../mail/templates.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { LoginService } from './login.service.js';
import { isValidVerifier } from './srp.js';
import { hashToken, hmac, minutesFromNow, randomToken } from './tokens.js';

export const RECOVERY_CODE_TTL_MINUTES = 15;
export const RECOVERY_TOKEN_TTL_MINUTES = 15;
/** Wrong email codes or recovery codes one attempt may try. */
export const MAX_RECOVERY_ATTEMPTS = 5;
/** Per email: at most one emailed code a minute and five an hour. */
export const RECOVERY_RESEND_COOLDOWN_MS = 60_000;
export const MAX_RECOVERY_CODES_PER_HOUR = 5;

/** One message for every failed check, so it can't tell an attacker which part was wrong. */
const RECOVERY_FAILED =
  'That email code or recovery code is incorrect, or the code has expired. Request a new email code and try again.';
const RECOVERY_EXPIRED = 'This recovery has expired. Start again.';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/**
 * Master password change and account recovery. The server only ever handles
 * what the app derived on the device: SRP verifiers, sealed keysets and the
 * SHA-256 of a recovery auth token. It can check a recovery code but can't
 * open the keyset copy the code seals.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly login: LoginService,
    private readonly sessions: SessionStore,
    private readonly twoFactor: TwoFactorService,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Replaces the master password's verifier and sealed keyset after a fresh
   * proof of the current password. Every other session is signed out, and
   * logins that already passed the old password stop.
   */
  async changePassword(
    accountId: string,
    keepSessionId: string,
    req: z.output<typeof PasswordChangeRequest>,
  ): Promise<ReauthenticatedResponse> {
    const verifier = Buffer.from(req.srpVerifier, 'base64url');
    if (!isValidVerifier(verifier)) throw new BadRequestException('Invalid SRP verifier');
    const { srpM2 } = await this.login.reauthenticate(accountId, req);

    const email = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(accounts)
        .set({
          kdf: req.kdf,
          srpVerifier: verifier,
          encryptedKeyset: req.encryptedKeyset,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning({ email: accounts.email });
      await this.dropPendingLogins(tx, accountId);
      return row?.email;
    });
    if (!email) throw new UnauthorizedException();
    await this.sessions.revokeAllExcept(accountId, keepSessionId);
    await this.notify(passwordChangedEmail(email));
    return { srpM2 };
  }

  async status(accountId: string): Promise<AccountRecoveryStatus> {
    const [row] = await this.db
      .select({ updatedAt: accounts.recoveryUpdatedAt, verifier: accounts.recoveryVerifier })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) throw new UnauthorizedException();
    return {
      enabled: row.verifier !== null,
      updatedAt: row.verifier ? (row.updatedAt?.toISOString() ?? null) : null,
    };
  }

  /** Sets up or replaces the recovery code, after a fresh proof of the master password. */
  async setUp(
    accountId: string,
    req: z.output<typeof AccountRecoverySetupRequest>,
  ): Promise<ReauthenticatedResponse> {
    const { srpM2 } = await this.login.reauthenticate(accountId, req);
    const [before] = await this.db
      .select({ verifier: accounts.recoveryVerifier })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    const [row] = await this.db
      .update(accounts)
      .set({
        recoveryKeyset: req.recoveryKeyset,
        recoveryVerifier: Buffer.from(req.recoveryVerifier, 'base64url'),
        recoveryUpdatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ email: accounts.email });
    if (!row) throw new UnauthorizedException();
    await this.notify(recoveryCodeSetEmail(row.email, before?.verifier != null));
    return { srpM2 };
  }

  /**
   * Emails a six-digit code to start a recovery. Responds the same way for
   * every address; an account without a recovery code gets an email saying so,
   * and unknown addresses get nothing.
   */
  async start(email: string): Promise<void> {
    const now = new Date();
    const [account] = await this.db
      .select({ id: accounts.id, verifier: accounts.recoveryVerifier })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);
    const recoverable = account?.verifier != null;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const issued = await this.db.transaction(async (tx) => {
      // Serialize per address so parallel requests can't each pass the rate check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'recover:' + email}))`);
      const recent = await tx
        .select({ createdAt: accountRecoveries.createdAt })
        .from(accountRecoveries)
        .where(
          and(
            eq(accountRecoveries.email, email),
            gt(accountRecoveries.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        )
        .orderBy(desc(accountRecoveries.createdAt));
      const last = recent[0]?.createdAt;
      if (
        recent.length >= MAX_RECOVERY_CODES_PER_HOUR ||
        (last && now.getTime() - last.getTime() < RECOVERY_RESEND_COOLDOWN_MS)
      ) {
        return false;
      }
      await tx
        .update(accountRecoveries)
        .set({ closedAt: now })
        .where(
          and(
            eq(accountRecoveries.email, email),
            isNull(accountRecoveries.verifiedAt),
            isNull(accountRecoveries.closedAt),
          ),
        );
      // Unrecoverable addresses still get a (never-valid) row, so the rate
      // limit behaves the same for every address.
      await tx.insert(accountRecoveries).values({
        accountId: account?.id ?? null,
        email,
        codeHash: recoverable ? this.codeHash(email, code) : randomBytes(32),
        expiresAt: minutesFromNow(RECOVERY_CODE_TTL_MINUTES, now),
        closedAt: recoverable ? null : now,
      });
      return true;
    });
    if (!issued || !account) return;

    const message = recoverable
      ? recoveryCodeEmail(email, code, RECOVERY_CODE_TTL_MINUTES)
      : recoveryUnavailableEmail(email);
    try {
      await this.mailer.send(message);
    } catch (err) {
      this.logger.error(`Could not send email: ${String(err)}`);
      throw new ServiceUnavailableException('Could not send the email. Try again shortly.');
    }
  }

  /**
   * Checks the emailed code and the recovery auth token together, then
   * releases the recovery copy of the keyset and a single-use token for
   * `complete`. Wrong tries count against the attempt; five close it.
   */
  async verify(email: string, code: string, recoveryAuth: string): Promise<RecoverVerifyResponse> {
    const now = new Date();
    const [pending] = await this.db
      .select()
      .from(accountRecoveries)
      .where(
        and(
          eq(accountRecoveries.email, email),
          isNull(accountRecoveries.verifiedAt),
          isNull(accountRecoveries.closedAt),
          gt(accountRecoveries.expiresAt, now),
        ),
      )
      .orderBy(desc(accountRecoveries.createdAt))
      .limit(1);
    if (!pending?.accountId) throw new BadRequestException(RECOVERY_FAILED);

    const [account] = await this.db
      .select({ keyset: accounts.recoveryKeyset, verifier: accounts.recoveryVerifier })
      .from(accounts)
      .where(eq(accounts.id, pending.accountId))
      .limit(1);
    const codeOk = timingSafeEqual(pending.codeHash, this.codeHash(email, code));
    const authOk =
      !!account?.verifier &&
      timingSafeEqual(account.verifier, sha256(Buffer.from(recoveryAuth, 'base64url')));
    if (!codeOk || !authOk || !account?.keyset) {
      await this.db
        .update(accountRecoveries)
        .set({
          attempts: sql`${accountRecoveries.attempts} + 1`,
          closedAt: sql`case when ${accountRecoveries.attempts} + 1 >= ${MAX_RECOVERY_ATTEMPTS} then now() else ${accountRecoveries.closedAt} end`,
        })
        .where(eq(accountRecoveries.id, pending.id));
      throw new BadRequestException(RECOVERY_FAILED);
    }

    const recoveryToken = randomToken();
    const expiresAt = minutesFromNow(RECOVERY_TOKEN_TTL_MINUTES, now);
    const [verified] = await this.db
      .update(accountRecoveries)
      .set({ verifiedAt: now, tokenHash: hashToken(recoveryToken), tokenExpiresAt: expiresAt })
      .where(
        and(
          eq(accountRecoveries.id, pending.id),
          isNull(accountRecoveries.verifiedAt),
          isNull(accountRecoveries.closedAt),
        ),
      )
      .returning({ id: accountRecoveries.id });
    if (!verified) throw new BadRequestException(RECOVERY_FAILED);

    return {
      recoveryToken: recoveryToken as RecoverVerifyResponse['recoveryToken'],
      expiresAt: expiresAt.toISOString(),
      recoveryKeyset: account.keyset,
      twoFactorRequired: await this.twoFactor.isEnabled(pending.accountId),
    };
  }

  /**
   * Replaces the account's master password, Secret Key and recovery code with
   * what the app derived after opening the recovery copy, signs out every
   * session and opens a new one for this device.
   */
  async complete(req: z.output<typeof RecoverCompleteRequest>): Promise<RecoverCompleteResponse> {
    const verifier = Buffer.from(req.srpVerifier, 'base64url');
    if (!isValidVerifier(verifier)) throw new BadRequestException('Invalid SRP verifier');
    const now = new Date();
    const tokenHash = hashToken(req.recoveryToken);

    const [pending] = await this.db
      .select({ accountId: accountRecoveries.accountId })
      .from(accountRecoveries)
      .where(
        and(
          eq(accountRecoveries.tokenHash, tokenHash),
          isNull(accountRecoveries.tokenUsedAt),
          gt(accountRecoveries.tokenExpiresAt, now),
        ),
      )
      .limit(1);
    if (!pending?.accountId) throw new BadRequestException(RECOVERY_EXPIRED);
    const accountId = pending.accountId;

    // 2FA is checked before the token is spent, so a mistyped code can be
    // retried; wrong codes count against the account's 2FA lockout.
    if (await this.twoFactor.isEnabled(accountId)) {
      if (!req.twoFactor) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'two_factor_required',
          message: 'Enter a code from your authenticator app.',
        });
      }
      await this.twoFactor.verify(accountId, req.twoFactor);
    }

    const email = await this.db.transaction(async (tx) => {
      const [claim] = await tx
        .update(accountRecoveries)
        .set({ tokenUsedAt: now })
        .where(
          and(
            eq(accountRecoveries.tokenHash, tokenHash),
            isNull(accountRecoveries.tokenUsedAt),
            gt(accountRecoveries.tokenExpiresAt, now),
          ),
        )
        .returning({ accountId: accountRecoveries.accountId });
      if (claim?.accountId !== accountId) throw new ConflictException(RECOVERY_EXPIRED);
      const [row] = await tx
        .update(accounts)
        .set({
          secretKeyId: req.secretKeyId,
          kdf: req.kdf,
          srpVerifier: verifier,
          encryptedKeyset: req.encryptedKeyset,
          recoveryKeyset: req.recoveryKeyset,
          recoveryVerifier: Buffer.from(req.recoveryVerifier, 'base64url'),
          recoveryUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(accounts.id, accountId))
        .returning({ email: accounts.email });
      await this.dropPendingLogins(tx, accountId);
      return row?.email;
    });
    if (!email) throw new BadRequestException(RECOVERY_EXPIRED);

    const { session, token } = await this.sessions.issue(accountId, req.device);
    await this.sessions.revokeAllExcept(accountId, session.id);
    await this.notify(accountRecoveredEmail(email));
    return {
      sessionToken: token as RecoverCompleteResponse['sessionToken'],
      expiresAt: session.expiresAt.toISOString(),
      accountId,
    };
  }

  /** Logins that already passed the old master password must not finish. */
  private async dropPendingLogins(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    accountId: string,
  ): Promise<void> {
    await tx.delete(srpChallenges).where(eq(srpChallenges.accountId, accountId));
    await tx
      .delete(loginTwoFactorChallenges)
      .where(eq(loginTwoFactorChallenges.accountId, accountId));
  }

  /** Security notices are best-effort: the change already happened. */
  private async notify(message: MailMessage): Promise<void> {
    try {
      await this.mailer.send(message);
    } catch (err) {
      this.logger.error(`Could not send security notice: ${String(err)}`);
    }
  }

  private codeHash(email: string, code: string): Buffer {
    return hmac(this.env.SERVER_SECRET, 'recovery-code', email, code);
  }
}

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  KDF_DEFAULTS,
  SRP_GROUP_BYTES,
  type EncryptedBlob,
  type LoginFinishRequest,
  type LoginFinishResponse,
  type LoginStartResponse,
  type LoginTwoFactorRequiredResponse,
  type LoginTwoFactorResponse,
  type TwoFactorProof,
} from '@zvault/shared';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { hkdfSync } from 'node:crypto';
import type { z } from 'zod';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, loginTwoFactorChallenges, srpChallenges, type StoredKdf } from '../db/schema.js';
import { SessionStore } from '../devices/session.store.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { createChallenge, pad, toInt, verifyClient } from './srp.js';
import { hashToken, hmac, minutesFromNow, randomToken } from './tokens.js';

export const CHALLENGE_TTL_MINUTES = 2;
/** How long a login that passed the password step waits for its 2FA code. */
export const TWO_FACTOR_CHALLENGE_TTL_MINUTES = 5;
/** Codes one pending login may try; the 2FA lockout also applies across logins. */
export const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;

const TWO_FACTOR_EXPIRED = 'Your sign-in expired. Sign in again.';

/** One message for every failure, so it can't tell an attacker which part was wrong. */
const LOGIN_FAILED = 'Incorrect email, master password or Secret Key.';

@Injectable()
export class LoginService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionStore,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /**
   * Step 1: returns the account's KDF parameters and the server's SRP `B`.
   * Unknown emails get a stable decoy so the response doesn't reveal whether
   * an account exists.
   */
  async start(email: string): Promise<LoginStartResponse> {
    const now = new Date();
    await this.db.delete(srpChallenges).where(lt(srpChallenges.expiresAt, now));

    const [account] = await this.db
      .select({ id: accounts.id, kdf: accounts.kdf, srpVerifier: accounts.srpVerifier })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);
    const { kdf, verifier } = account
      ? { kdf: account.kdf, verifier: account.srpVerifier }
      : this.decoy(email);

    const challenge = createChallenge(verifier);
    const [row] = await this.db
      .insert(srpChallenges)
      .values({
        accountId: account?.id ?? null,
        email,
        secretB: challenge.secretB,
        publicB: challenge.publicB,
        expiresAt: minutesFromNow(CHALLENGE_TTL_MINUTES, now),
      })
      .returning({ id: srpChallenges.id });

    return {
      loginId: row!.id,
      kdf: kdf as LoginStartResponse['kdf'],
      srpB: challenge.publicB.toString('base64url') as LoginStartResponse['srpB'],
    };
  }

  /**
   * Step 2: checks the client's proof. If it holds, opens a session, or, when
   * the account has 2FA on, parks the login until `finishTwoFactor`.
   */
  async finish(req: z.output<typeof LoginFinishRequest>): Promise<LoginFinishResponse> {
    // Delete on read: each challenge can be tried exactly once.
    const [challenge] = await this.db
      .delete(srpChallenges)
      .where(eq(srpChallenges.id, req.loginId))
      .returning();
    if (!challenge || challenge.expiresAt <= new Date()) {
      throw new UnauthorizedException(LOGIN_FAILED);
    }

    const [account] = challenge.accountId
      ? await this.db.select().from(accounts).where(eq(accounts.id, challenge.accountId)).limit(1)
      : [];
    // Decoys run the same checks so both paths take about as long.
    const { kdf, verifier } = account
      ? { kdf: account.kdf, verifier: account.srpVerifier }
      : this.decoy(challenge.email);

    const verified = verifyClient({
      identity: challenge.email,
      salt: Buffer.from(kdf.salt, 'base64url'),
      verifier,
      challenge,
      publicA: Buffer.from(req.srpA, 'base64url'),
      clientProof: Buffer.from(req.srpM1, 'base64url'),
    });
    if (!verified || !account) throw new UnauthorizedException(LOGIN_FAILED);

    const srpM2 = verified.serverProof.toString('base64url') as LoginFinishResponse['srpM2'];

    if (await this.twoFactor.isEnabled(account.id)) {
      const now = new Date();
      await this.db
        .delete(loginTwoFactorChallenges)
        .where(lt(loginTwoFactorChallenges.expiresAt, now));
      const token = randomToken();
      const expiresAt = minutesFromNow(TWO_FACTOR_CHALLENGE_TTL_MINUTES, now);
      await this.db.insert(loginTwoFactorChallenges).values({
        accountId: account.id,
        tokenHash: hashToken(token),
        device: req.device,
        expiresAt,
      });
      return {
        srpM2,
        twoFactorRequired: true,
        twoFactorToken: token as LoginTwoFactorRequiredResponse['twoFactorToken'],
        expiresAt: expiresAt.toISOString(),
      };
    }

    return { srpM2, ...(await this.openSession(account, req.device)) };
  }

  /**
   * Step 3, for accounts with 2FA: spends a TOTP or recovery code and opens
   * the session. Wrong codes count against both this login and the account's
   * 2FA lockout.
   */
  async finishTwoFactor(token: string, proof: TwoFactorProof): Promise<LoginTwoFactorResponse> {
    const now = new Date();
    // Count the attempt before checking the code, so parallel guesses can't exceed the limit.
    const [challenge] = await this.db
      .update(loginTwoFactorChallenges)
      .set({ attempts: sql`${loginTwoFactorChallenges.attempts} + 1` })
      .where(
        and(
          eq(loginTwoFactorChallenges.tokenHash, hashToken(token)),
          gt(loginTwoFactorChallenges.expiresAt, now),
          lt(loginTwoFactorChallenges.attempts, TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!challenge) throw new UnauthorizedException(TWO_FACTOR_EXPIRED);

    await this.twoFactor.verify(challenge.accountId, proof);

    const [spent] = await this.db
      .delete(loginTwoFactorChallenges)
      .where(eq(loginTwoFactorChallenges.id, challenge.id))
      .returning({ id: loginTwoFactorChallenges.id });
    const [account] = spent
      ? await this.db.select().from(accounts).where(eq(accounts.id, challenge.accountId)).limit(1)
      : [];
    if (!account) throw new UnauthorizedException(TWO_FACTOR_EXPIRED);
    return this.openSession(account, challenge.device);
  }

  private async openSession(
    account: { id: string; encryptedKeyset: EncryptedBlob },
    device: z.output<typeof LoginFinishRequest>['device'],
  ): Promise<LoginTwoFactorResponse> {
    const { session, token } = await this.sessions.issue(account.id, device);
    return {
      sessionToken: token as LoginTwoFactorResponse['sessionToken'],
      expiresAt: session.expiresAt.toISOString(),
      accountId: account.id,
      encryptedKeyset: account.encryptedKeyset,
    };
  }

  /** Stable per-email fake KDF salt and verifier for addresses with no account. */
  private decoy(email: string): { kdf: StoredKdf; verifier: Buffer } {
    const key = hmac(this.env.SERVER_SECRET, 'login-decoy', email);
    const salt = Buffer.from(hkdfSync('sha256', key, '', 'salt', 16));
    const v = Buffer.from(hkdfSync('sha256', key, '', 'verifier', SRP_GROUP_BYTES));
    return {
      kdf: { ...KDF_DEFAULTS, salt: salt.toString('base64url') },
      // Any value below N is a plausible verifier; the top byte of N is 0xff.
      verifier: pad(toInt(v) >> 8n),
    };
  }
}

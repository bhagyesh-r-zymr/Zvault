import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  KDF_DEFAULTS,
  SRP_GROUP_BYTES,
  type LoginFinishRequest,
  type LoginFinishResponse,
  type LoginStartResponse,
} from '@zvault/shared';
import { eq, lt } from 'drizzle-orm';
import { hkdfSync } from 'node:crypto';
import type { z } from 'zod';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, srpChallenges, type StoredKdf } from '../db/schema.js';
import { SessionService } from './session.service.js';
import { createChallenge, pad, toInt, verifyClient } from './srp.js';
import { hmac, minutesFromNow } from './tokens.js';

export const CHALLENGE_TTL_MINUTES = 2;

/** One message for every failure, so it can't tell an attacker which part was wrong. */
const LOGIN_FAILED = 'Incorrect email, master password or Secret Key.';

@Injectable()
export class LoginService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionService,
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

  /** Step 2: checks the client's proof and, if it holds, opens a session. */
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

    const session = await this.sessions.create(account.id);
    return {
      srpM2: verified.serverProof.toString('base64url') as LoginFinishResponse['srpM2'],
      sessionToken: session.token as LoginFinishResponse['sessionToken'],
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

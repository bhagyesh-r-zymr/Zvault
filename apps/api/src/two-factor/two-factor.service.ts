import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  RecoveryCodesResponse,
  TotpSetupResponse,
  TwoFactorProof,
  TwoFactorStatusResponse,
} from '@zvault/shared';
import { TWO_FACTOR_CLOCK, type Clock } from './clock.js';
import { TWO_FACTOR_CONFIG, type TwoFactorConfig } from './two-factor.config.js';
import { TwoFactorCrypto } from './two-factor.crypto.js';
import {
  TWO_FACTOR_REPOSITORY,
  type TwoFactorRecord,
  type TwoFactorRepository,
} from './two-factor.repository.js';
import { generateTotpSecret, otpauthUri, base32Encode, verifyTotp } from './totp.js';

/** How long a started setup waits for its first code. */
export const SETUP_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the second factor locks. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;

export class InvalidTwoFactorCodeException extends ForbiddenException {
  constructor() {
    super({ error: 'invalid_two_factor_code', message: 'The code is incorrect or expired.' });
  }
}

export class TwoFactorLockedException extends HttpException {
  constructor(until: Date) {
    super(
      {
        error: 'two_factor_locked',
        message: 'Too many incorrect codes. Try again later.',
        retryAfter: until.toISOString(),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Serialized writers retry this many times when another request won the race. */
const MAX_WRITE_ATTEMPTS = 3;

/**
 * TOTP second factor. The login flow calls `isEnabled` and `verify`; the
 * signed-in user manages enrollment through the controller.
 */
@Injectable()
export class TwoFactorService {
  private readonly crypto: TwoFactorCrypto;

  constructor(
    @Inject(TWO_FACTOR_REPOSITORY) private readonly repo: TwoFactorRepository,
    @Inject(TWO_FACTOR_CONFIG) private readonly config: TwoFactorConfig,
    @Inject(TWO_FACTOR_CLOCK) private readonly clock: Clock,
  ) {
    this.crypto = new TwoFactorCrypto(config.masterKey);
  }

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.repo.find(userId))?.totpSecret != null;
  }

  async status(userId: string): Promise<TwoFactorStatusResponse> {
    const r = await this.repo.find(userId);
    const enabled = r?.totpSecret != null;
    return {
      totpEnabled: enabled,
      recoveryCodesRemaining: enabled ? r.recoveryCodeHashes.length : 0,
      enabledAt: enabled && r.enabledAt ? r.enabledAt.toISOString() : null,
    };
  }

  /** Starts (or restarts) enrollment with a fresh secret. */
  async beginSetup(userId: string, accountName: string): Promise<TotpSetupResponse> {
    const secret = generateTotpSecret();
    try {
      const expiresAt = new Date(this.clock.now() + SETUP_TTL_MS);
      await this.mutate(userId, (r) => {
        if (r.totpSecret) throw new ConflictException({ error: 'two_factor_already_enabled' });
        return {
          ...r,
          pendingSecret: this.crypto.seal(userId, secret),
          pendingExpiresAt: expiresAt,
        };
      });
      return {
        otpauthUri: otpauthUri(secret, this.config.issuer, accountName),
        secret: base32Encode(secret),
        expiresAt: expiresAt.toISOString(),
      };
    } finally {
      secret.fill(0);
    }
  }

  /** Turns 2FA on once the user proves the authenticator works. */
  async confirmSetup(userId: string, code: string): Promise<RecoveryCodesResponse> {
    const { codes, hashes } = this.crypto.generateRecoveryCodes(userId);
    await this.mutate(userId, (r) => {
      if (r.totpSecret) throw new ConflictException({ error: 'two_factor_already_enabled' });
      const now = this.clock.now();
      if (!r.pendingSecret || !r.pendingExpiresAt || r.pendingExpiresAt.getTime() <= now) {
        throw new NotFoundException({ error: 'two_factor_setup_not_started' });
      }
      this.assertNotLocked(r);
      const step = verifyTotp(this.crypto.open(userId, r.pendingSecret), code, now, null);
      if (step === null) return this.recordFailure(r);
      return {
        ...r,
        totpSecret: r.pendingSecret,
        enabledAt: new Date(now),
        lastUsedStep: step,
        pendingSecret: null,
        pendingExpiresAt: null,
        recoveryCodeHashes: hashes,
        failedAttempts: 0,
        lockedUntil: null,
      };
    });
    return { recoveryCodes: codes };
  }

  /**
   * Checks a second-factor proof and consumes it: a TOTP code cannot be used
   * twice, and a recovery code is deleted. Throws on failure. Callers must
   * only call this for a user who already passed the first factor.
   */
  async verify(userId: string, proof: TwoFactorProof): Promise<void> {
    await this.mutate(userId, (r) => this.consumeProof(userId, r, proof));
  }

  async regenerateRecoveryCodes(
    userId: string,
    proof: TwoFactorProof,
  ): Promise<RecoveryCodesResponse> {
    const { codes, hashes } = this.crypto.generateRecoveryCodes(userId);
    await this.mutate(userId, (r) => {
      const next = this.consumeProof(userId, r, proof);
      return next.failedAttempts > 0 ? next : { ...next, recoveryCodeHashes: hashes };
    });
    return { recoveryCodes: codes };
  }

  async disable(userId: string, proof: TwoFactorProof): Promise<void> {
    await this.mutate(userId, (r) => {
      const next = this.consumeProof(userId, r, proof);
      if (next.failedAttempts > 0) return next;
      return {
        ...next,
        totpSecret: null,
        enabledAt: null,
        lastUsedStep: null,
        pendingSecret: null,
        pendingExpiresAt: null,
        recoveryCodeHashes: [],
      };
    });
  }

  /**
   * Returns the record with the proof spent, or with a failure recorded. A
   * returned record with `failedAttempts > 0` means the proof was wrong;
   * `mutate` persists it and then throws.
   */
  private consumeProof(userId: string, r: TwoFactorRecord, proof: TwoFactorProof): TwoFactorRecord {
    if (!r.totpSecret) throw new NotFoundException({ error: 'two_factor_not_enabled' });
    this.assertNotLocked(r);
    const ok = { ...r, failedAttempts: 0, lockedUntil: null };
    if ('code' in proof) {
      const secret = this.crypto.open(userId, r.totpSecret);
      const step = verifyTotp(secret, proof.code, this.clock.now(), r.lastUsedStep);
      secret.fill(0);
      return step === null ? this.recordFailure(r) : { ...ok, lastUsedStep: step };
    }
    const index = this.crypto.findRecoveryCode(userId, proof.recoveryCode, r.recoveryCodeHashes);
    if (index < 0) return this.recordFailure(r);
    return { ...ok, recoveryCodeHashes: r.recoveryCodeHashes.filter((_, i) => i !== index) };
  }

  private recordFailure(r: TwoFactorRecord): TwoFactorRecord {
    const lockExpired = r.lockedUntil !== null && r.lockedUntil.getTime() <= this.clock.now();
    const failedAttempts = (lockExpired ? 0 : r.failedAttempts) + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS ? new Date(this.clock.now() + LOCKOUT_MS) : null;
    return { ...r, failedAttempts, lockedUntil };
  }

  private assertNotLocked(r: TwoFactorRecord): void {
    if (r.lockedUntil && r.lockedUntil.getTime() > this.clock.now()) {
      throw new TwoFactorLockedException(r.lockedUntil);
    }
  }

  /**
   * Read-modify-write with compare-and-set. A result whose `failedAttempts`
   * went up is a rejected proof: it is saved, then reported as an error.
   */
  private async mutate(
    userId: string,
    change: (r: TwoFactorRecord) => TwoFactorRecord,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const current = (await this.repo.find(userId)) ?? emptyRecord(userId);
      const next = change(current);
      if (!(await this.repo.update(next, current.version))) continue;
      if (next.failedAttempts > 0 && next.failedAttempts !== current.failedAttempts) {
        if (next.lockedUntil) throw new TwoFactorLockedException(next.lockedUntil);
        throw new InvalidTwoFactorCodeException();
      }
      return;
    }
    throw new ConflictException({ error: 'two_factor_busy', message: 'Please try again.' });
  }
}

function emptyRecord(userId: string): TwoFactorRecord {
  return {
    userId,
    totpSecret: null,
    enabledAt: null,
    lastUsedStep: null,
    pendingSecret: null,
    pendingExpiresAt: null,
    recoveryCodeHashes: [],
    failedAttempts: 0,
    lockedUntil: null,
    version: 0,
  };
}

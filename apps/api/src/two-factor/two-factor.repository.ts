/** Everything the server stores about a user's second factor. */
export interface TwoFactorRecord {
  userId: string;
  /** Sealed secret of the confirmed authenticator, or null when 2FA is off. */
  totpSecret: string | null;
  enabledAt: Date | null;
  /** Highest TOTP time step accepted so far, for replay protection. */
  lastUsedStep: number | null;
  /** Sealed secret awaiting its first valid code. */
  pendingSecret: string | null;
  pendingExpiresAt: Date | null;
  /** Keyed hashes of unused recovery codes; a code is removed when used. */
  recoveryCodeHashes: string[];
  failedAttempts: number;
  lockedUntil: Date | null;
  /** Incremented on every write; used for optimistic concurrency. */
  version: number;
}

/**
 * Storage port for 2FA state. The database layer provides the real
 * implementation; `update` must be a compare-and-set on `version` so two
 * concurrent requests cannot both spend the same code.
 */
export interface TwoFactorRepository {
  find(userId: string): Promise<TwoFactorRecord | null>;
  /** Writes `next` (with `version` incremented) only if the stored version is `expectedVersion`; 0 means "not stored yet". */
  update(next: TwoFactorRecord, expectedVersion: number): Promise<boolean>;
  delete(userId: string): Promise<void>;
}

export const TWO_FACTOR_REPOSITORY = Symbol('TWO_FACTOR_REPOSITORY');

/** Process-local store for development and tests. */
export class InMemoryTwoFactorRepository implements TwoFactorRepository {
  private readonly records = new Map<string, TwoFactorRecord>();

  find(userId: string): Promise<TwoFactorRecord | null> {
    const r = this.records.get(userId);
    return Promise.resolve(r ? clone(r) : null);
  }

  update(next: TwoFactorRecord, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(next.userId);
    if ((current?.version ?? 0) !== expectedVersion) return Promise.resolve(false);
    this.records.set(next.userId, clone({ ...next, version: expectedVersion + 1 }));
    return Promise.resolve(true);
  }

  delete(userId: string): Promise<void> {
    this.records.delete(userId);
    return Promise.resolve();
  }
}

function clone(r: TwoFactorRecord): TwoFactorRecord {
  return { ...r, recoveryCodeHashes: [...r.recoveryCodeHashes] };
}

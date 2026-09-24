/** Injectable time source so expiry, lockout and TOTP steps are testable. */
export interface Clock {
  now(): number;
}

export const TWO_FACTOR_CLOCK = Symbol('TWO_FACTOR_CLOCK');

export const systemClock: Clock = { now: () => Date.now() };

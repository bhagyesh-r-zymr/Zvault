/** A 0–4 rating shared by generated secrets and zxcvbn scores. */
export type Rating = 0 | 1 | 2 | 3 | 4;

export const RATING_LABELS: Record<Rating, string> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

/**
 * Rates a generated secret by its exact entropy. Thresholds: under 40 bits
 * falls to a determined offline attacker, 64 bits (a five-word passphrase)
 * is fine behind Argon2id, 80 bits and up is strong anywhere.
 */
export function ratingFromEntropy(bits: number): Rating {
  if (bits < 28) return 0;
  if (bits < 40) return 1;
  if (bits < 64) return 2;
  if (bits < 80) return 3;
  return 4;
}

export function ratingFromScore(score: number): Rating {
  return Math.min(4, Math.max(0, Math.trunc(score))) as Rating;
}

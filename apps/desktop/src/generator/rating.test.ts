import { describe, expect, it } from 'vitest';
import { ratingFromEntropy, ratingFromScore } from './rating.js';

describe('ratingFromEntropy', () => {
  it('rates by bits of entropy', () => {
    expect(ratingFromEntropy(26.6)).toBe(0); // 8-digit PIN
    expect(ratingFromEntropy(38.8)).toBe(1); // 3-word passphrase
    expect(ratingFromEntropy(51.7)).toBe(2); // 4-word passphrase
    expect(ratingFromEntropy(64.6)).toBe(3); // 5-word passphrase
    expect(ratingFromEntropy(129.4)).toBe(4); // default 20-char password
  });
});

describe('ratingFromScore', () => {
  it('clamps zxcvbn scores into range', () => {
    expect(ratingFromScore(-1)).toBe(0);
    expect(ratingFromScore(2)).toBe(2);
    expect(ratingFromScore(7)).toBe(4);
  });
});

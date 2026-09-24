import { describe, expect, it } from 'vitest';
import { formatCode, secondsLeft } from './countdown.js';

describe('secondsLeft', () => {
  const f = { code: { code: '123456', period: 30, remaining: 10 }, fetchedAt: 1_000_000 };

  it('counts down from when the code was fetched', () => {
    expect(secondsLeft(f, 1_000_000)).toBe(10);
    expect(secondsLeft(f, 1_000_999)).toBe(10);
    expect(secondsLeft(f, 1_004_000)).toBe(6);
  });

  it('stops at zero', () => {
    expect(secondsLeft(f, 1_060_000)).toBe(0);
  });
});

describe('formatCode', () => {
  it('splits codes in half', () => {
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12345678')).toBe('1234 5678');
    expect(formatCode('1234567')).toBe('1234 567');
  });
});

import { describe, expect, it } from 'vitest';
import { ago, daysLeft, trashLine } from './when.js';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();
const after = (ms: number) => new Date(NOW + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('trash times', () => {
  it('says how long ago something was deleted', () => {
    expect(ago(before(10_000), NOW)).toBe('just now');
    expect(ago(before(60_000), NOW)).toBe('1 minute ago');
    expect(ago(before(3 * 60 * 60_000), NOW)).toBe('3 hours ago');
    expect(ago(before(DAY + 1), NOW)).toBe('yesterday');
    expect(ago(before(5 * DAY), NOW)).toBe('5 days ago');
  });

  it('counts the days left, rounding up', () => {
    expect(daysLeft(after(28 * DAY - 1), NOW)).toBe(28);
    expect(daysLeft(before(DAY), NOW)).toBe(0);
  });

  it('combines both', () => {
    expect(trashLine(before(2 * DAY), after(28 * DAY), NOW)).toBe(
      'Deleted 2 days ago · 28 days left',
    );
    expect(trashLine(before(30 * DAY - 60_000), after(60_000), NOW)).toBe(
      'Deleted 29 days ago · goes for good today',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { lastActive, platformLabel } from './format.js';

const now = new Date('2026-09-24T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

describe('lastActive', () => {
  it('reads recent activity as now', () => {
    expect(lastActive(ago(30), now)).toBe('Active now');
  });

  it('uses the largest whole unit', () => {
    expect(lastActive(ago(5 * 60), now)).toBe('5 minutes ago');
    expect(lastActive(ago(3 * 3600 + 59), now)).toBe('3 hours ago');
    expect(lastActive(ago(86_400), now)).toBe('yesterday');
    expect(lastActive(ago(4 * 86_400), now)).toBe('4 days ago');
  });

  it('treats clock skew into the future as now', () => {
    expect(lastActive(ago(-600), now)).toBe('Active now');
  });
});

describe('platformLabel', () => {
  it('names platforms for people', () => {
    expect(platformLabel('macos')).toBe('macOS');
  });
});

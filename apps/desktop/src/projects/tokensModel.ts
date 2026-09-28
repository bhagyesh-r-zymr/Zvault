import type { Environment } from './model.js';

/**
 * The environments a token for `environmentId` carries keys for: that one,
 * then the ones it inherits values from, nearest first. The chain stops at an
 * environment this device holds no key for (its values can't be handed on),
 * and at a loop.
 */
export function tokenChain(environments: readonly Environment[], environmentId: string): string[] {
  const out: string[] = [];
  let next: string | null = environmentId;
  while (next && !out.includes(next)) {
    const env = environments.find((e) => e.id === next);
    if (!env || env.locked) break;
    out.push(env.id);
    next = env.inheritsFrom;
  }
  return out;
}

/** "in 30 days", "tomorrow", "today", "expired". */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Lines to paste where the token is used; the token itself is copied separately. */
export function usageSnippet(place: string): string {
  return [
    'export ZVAULT_TOKEN=…   # store it as a CI secret',
    `zv run --env-from ${place} -- npm test`,
    `zv read ${place}/DATABASE_URL`,
  ].join('\n');
}

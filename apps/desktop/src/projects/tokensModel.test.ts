import { describe, expect, it } from 'vitest';
import type { Environment } from './model.js';
import { expiresIn, tokenChain } from './tokensModel.js';

const env = (id: string, inheritsFrom: string | null, locked = false): Environment => ({
  id,
  revision: 1,
  name: id,
  slug: id,
  short: id,
  kind: 'custom',
  color: '#000000',
  position: 0,
  inheritsFrom,
  locked,
  sync: [],
});

describe('tokenChain', () => {
  it('follows what an environment inherits, nearest first', () => {
    const envs = [env('dev', null), env('staging', 'dev'), env('qa', 'staging')];
    expect(tokenChain(envs, 'qa')).toEqual(['qa', 'staging', 'dev']);
    expect(tokenChain(envs, 'dev')).toEqual(['dev']);
  });

  it('stops at a locked environment and at loops', () => {
    expect(tokenChain([env('dev', null, true), env('staging', 'dev')], 'staging')).toEqual([
      'staging',
    ]);
    expect(tokenChain([env('a', 'b'), env('b', 'a')], 'a')).toEqual(['a', 'b']);
    expect(tokenChain([env('a', null, true)], 'a')).toEqual([]);
  });
});

describe('expiresIn', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('says how long a token has left', () => {
    expect(expiresIn('2026-10-28T12:00:00Z', now)).toBe('in 30 days');
    expect(expiresIn('2026-09-29T13:00:00Z', now)).toBe('tomorrow');
    expect(expiresIn('2026-09-28T18:00:00Z', now)).toBe('today');
    expect(expiresIn('2026-09-27T12:00:00Z', now)).toBe('expired');
  });
});

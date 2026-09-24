import { describe, expect, it } from 'vitest';
import { checkPin, pinKey, type PinStore } from './pins.js';

function memory(): PinStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('sharing key pins', () => {
  it('reports new, then match, then changed', () => {
    const store = memory();
    expect(checkPin('Alice@Example.com', 'k1', store)).toBe('new');
    pinKey('alice@example.com', 'k1', store);
    expect(checkPin(' ALICE@example.com ', 'k1', store)).toBe('match');
    expect(checkPin('alice@example.com', 'k2', store)).toBe('changed');
  });

  it('treats unreadable storage as empty', () => {
    const store = memory();
    store.setItem('zvault.sharing.pins.v1', 'not json');
    expect(checkPin('a@b.co', 'k', store)).toBe('new');
  });
});

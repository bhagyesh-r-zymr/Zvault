import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createChallenge, isValidVerifier, pad, verifierFor, verifyClient } from './srp.js';

interface Vector {
  identity: string;
  salt: string;
  x: string;
  b: string;
  v: string;
  A: string;
  B: string;
  K: string;
  M1: string;
  M2: string;
}

const vector = JSON.parse(
  readFileSync(
    new URL('../../../../crates/zvault-crypto/tests/srp-v1.json', import.meta.url),
    'utf8',
  ),
) as Vector;
const hex = (s: string) => Buffer.from(s, 'hex');

describe('SRP server', () => {
  const challenge = createChallenge(hex(vector.v), hex(vector.b));
  const login = (overrides: Partial<Parameters<typeof verifyClient>[0]> = {}) =>
    verifyClient({
      identity: vector.identity,
      salt: hex(vector.salt),
      verifier: hex(vector.v),
      challenge,
      publicA: hex(vector.A),
      clientProof: hex(vector.M1),
      ...overrides,
    });

  it('matches the shared test vector', () => {
    expect(verifierFor(hex(vector.x)).toString('hex')).toBe(vector.v);
    expect(challenge.publicB.toString('hex')).toBe(vector.B);
    const result = login();
    expect(result?.sessionKey.toString('hex')).toBe(vector.K);
    expect(result?.serverProof.toString('hex')).toBe(vector.M2);
  });

  it('rejects a wrong proof', () => {
    const bad = hex(vector.M1);
    bad[0]! ^= 1;
    expect(login({ clientProof: bad })).toBeNull();
    expect(login({ clientProof: Buffer.alloc(0) })).toBeNull();
  });

  it('binds the proof to the identity and salt', () => {
    expect(login({ identity: 'mallory@example.com' })).toBeNull();
    expect(login({ salt: Buffer.alloc(16) })).toBeNull();
  });

  it('rejects A = 0 mod N and malformed A', () => {
    expect(login({ publicA: Buffer.alloc(384) })).toBeNull();
    expect(login({ publicA: Buffer.alloc(10, 1) })).toBeNull();
  });

  it('uses a fresh b for each challenge', () => {
    const one = createChallenge(hex(vector.v));
    const two = createChallenge(hex(vector.v));
    expect(one.publicB.equals(two.publicB)).toBe(false);
  });

  it('only accepts verifiers inside the group', () => {
    expect(isValidVerifier(hex(vector.v))).toBe(true);
    expect(isValidVerifier(pad(0n))).toBe(false);
    expect(isValidVerifier(pad(1n))).toBe(false);
    expect(isValidVerifier(Buffer.alloc(384, 0xff))).toBe(false);
    expect(isValidVerifier(Buffer.alloc(32, 1))).toBe(false);
  });
});

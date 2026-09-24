import { randomBytes } from 'node:crypto';
import { G, H_N_XOR_H_G, K, N, hash, modPow, pad, toInt } from '../src/auth/srp.js';

/**
 * Test-only SRP client, equivalent to `ClientSession` in zvault-crypto. The
 * real client derives `x` from the master password and Secret Key in Rust.
 */
export function clientLogin(params: {
  identity: string;
  salt: Buffer;
  x: Buffer;
  publicB: Buffer;
}): { publicA: Buffer; m1: Buffer; expectedM2: Buffer } {
  const a = toInt(randomBytes(32));
  const publicA = pad(modPow(G, a, N));
  const u = toInt(hash(publicA, params.publicB));
  const x = toInt(params.x);
  const kv = (K * modPow(G, x, N)) % N;
  const base = (((toInt(params.publicB) - kv) % N) + N) % N;
  const key = hash(pad(modPow(base, a + u * x, N)));
  const m1 = hash(
    H_N_XOR_H_G,
    hash(Buffer.from(params.identity)),
    params.salt,
    publicA,
    params.publicB,
    key,
  );
  return { publicA, m1, expectedM2: hash(publicA, m1, key) };
}

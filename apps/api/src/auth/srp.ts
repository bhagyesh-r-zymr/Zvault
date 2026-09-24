import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SRP_GROUP_BYTES } from '@zvault/shared';

/**
 * SRP-6a server, the mirror of `crates/zvault-crypto/src/srp.rs` (see the
 * spec there). Both sides are checked against `crates/zvault-crypto/tests/srp-v1.json`.
 */

// RFC 5054 3072-bit group.
export const N = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
    '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
    '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05' +
    '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB' +
    '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
    '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33' +
    'A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864' +
    'D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2' +
    '08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF',
);
export const G = 5n;

export const hash = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export const toInt = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt('0x' + Buffer.from(bytes).toString('hex'));

/** Big-endian, left-padded to the group size. */
export const pad = (n: bigint): Buffer => {
  const hex = n.toString(16).padStart(SRP_GROUP_BYTES * 2, '0');
  if (hex.length > SRP_GROUP_BYTES * 2) throw new RangeError('value exceeds group size');
  return Buffer.from(hex, 'hex');
};

// Not constant-time. Acceptable here: `b` is fresh per login and discarded.
export const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
};

export const K = toInt(hash(pad(N), pad(G)));
export const H_N_XOR_H_G = (() => {
  const hn = hash(pad(N));
  const hg = hash(Buffer.from([Number(G)]));
  return Buffer.from(hn.map((b, i) => b ^ hg[i]!));
})();

/** A verifier must be a group element other than 0 and 1. */
export function isValidVerifier(v: Uint8Array): boolean {
  const n = toInt(v);
  return v.length === SRP_GROUP_BYTES && n > 1n && n < N;
}

/** Derives `g^x` from `x`. Used by tests and decoy logins; clients do this themselves. */
export const verifierFor = (x: Uint8Array): Buffer => pad(modPow(G, toInt(x), N));

export interface ServerChallenge {
  secretB: Buffer;
  publicB: Buffer;
}

/** `B = k*v + g^b`, with a fresh 256-bit `b` unless one is given (tests). */
export function createChallenge(verifier: Uint8Array, secretB = randomBytes(32)): ServerChallenge {
  const b = toInt(secretB);
  const publicB = pad((K * toInt(verifier) + modPow(G, b, N)) % N);
  return { secretB: Buffer.from(secretB), publicB };
}

export interface VerifiedLogin {
  /** `M2`, returned to the client as proof the server holds the verifier. */
  serverProof: Buffer;
  /** The shared session key `K`. */
  sessionKey: Buffer;
}

/**
 * Checks the client's proof `M1`. Returns null on any failure, without saying
 * which check failed.
 */
export function verifyClient(params: {
  identity: string;
  salt: Uint8Array;
  verifier: Uint8Array;
  challenge: ServerChallenge;
  publicA: Uint8Array;
  clientProof: Uint8Array;
}): VerifiedLogin | null {
  const { identity, salt, verifier, challenge, publicA, clientProof } = params;
  if (publicA.length !== SRP_GROUP_BYTES) return null;
  const a = toInt(publicA);
  if (a % N === 0n) return null;

  const u = toInt(hash(publicA, challenge.publicB));
  if (u === 0n) return null;

  const s = modPow((a * modPow(toInt(verifier), u, N)) % N, toInt(challenge.secretB), N);
  const sessionKey = hash(pad(s));
  const expected = hash(
    H_N_XOR_H_G,
    hash(Buffer.from(identity, 'utf8')),
    salt,
    publicA,
    challenge.publicB,
    sessionKey,
  );
  if (clientProof.length !== expected.length || !timingSafeEqual(clientProof, expected)) {
    return null;
  }
  return { serverProof: hash(publicA, expected, sessionKey), sessionKey };
}

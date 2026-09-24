import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { EncryptedBlob } from '@zvault/shared';

/**
 * Browser half of share links. Must derive exactly what `LinkShare` in
 * crates/zvault-crypto derives; the tests pin both to the same vectors.
 */

const enc = new TextEncoder();
const ENC_INFO = enc.encode('zvault/v1/share-link/enc');
const AUTH_INFO = enc.encode('zvault/v1/share-link/auth');
const AAD_PREFIX = enc.encode('zvault/v1/share-link:');

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface ParsedLink {
  id: string;
  idBytes: Uint8Array;
  key: Uint8Array;
}

/** Links look like `https://share.example/#<id>.<key>`; both parts stay client-side. */
export function parseFragment(hash: string): ParsedLink | null {
  const m = /^#?([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m?.[1] || !m[2]) return null;
  return { id: m[1], idBytes: fromBase64Url(m[1]), key: fromBase64Url(m[2]) };
}

export function accessToken(link: ParsedLink): Uint8Array {
  return hkdf(sha256, link.key, link.idBytes, AUTH_INFO, 32);
}

export function encKey(link: ParsedLink): Uint8Array {
  return hkdf(sha256, link.key, link.idBytes, ENC_INFO, 32);
}

/** Throws if the ciphertext was altered or does not belong to this link. */
export function openBlob(link: ParsedLink, blob: EncryptedBlob): Uint8Array {
  const aad = new Uint8Array(AAD_PREFIX.length + link.idBytes.length);
  aad.set(AAD_PREFIX);
  aad.set(link.idBytes, AAD_PREFIX.length);
  return xchacha20poly1305(encKey(link), fromBase64Url(blob.nonce), aad).decrypt(
    fromBase64Url(blob.ct),
  );
}

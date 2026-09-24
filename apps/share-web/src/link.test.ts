import { describe, expect, it } from 'vitest';
import { accessToken, encKey, openBlob, parseFragment, toBase64Url } from './link.js';
import type { EncryptedBlob } from '@zvault/shared';

// Same vectors as `link_derivation_matches_the_published_vector` and
// `link_opens_the_published_ciphertext` in crates/zvault-crypto/src/share.rs.
const ID = 'EREREREREREREREREREREQ';
const KEY = 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI';
const blob = {
  v: 1,
  alg: 'xchacha20poly1305',
  kid: 'share-link',
  nonce: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz',
  ct: 'OxIm_4CmqP-u673oElR_tyeF35K9XCE8dbIiPuCrDMwJ9RAwXtTppx0IafEDVHg6bUj39IVar4bJiGT2dB14bwrr',
} as EncryptedBlob;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('share links', () => {
  const link = parseFragment(`#${ID}.${KEY}`);

  it('parses the fragment', () => {
    expect(link?.id).toBe(ID);
    expect(link?.key).toHaveLength(32);
    expect(parseFragment('#nope')).toBeNull();
    expect(parseFragment(`#${ID}.${KEY}x`)).toBeNull();
  });

  it('derives the same keys as the Rust core', () => {
    if (!link) throw new Error('unparsed');
    expect(hex(accessToken(link))).toBe(
      '187cc5b2a66cf01f738715d94d86c1ddf7e709740b48f117581b8dc3325b14ec',
    );
    expect(hex(encKey(link))).toBe(
      '49de694cd99cac8f20b5f357e096cc62ecd2c8e467c8e43413ccf49bf8a2e6ac',
    );
  });

  it('opens ciphertext bound to its id', () => {
    if (!link) throw new Error('unparsed');
    expect(new TextDecoder().decode(openBlob(link, blob))).toBe(
      '{"v":1,"title":"Wi-Fi","password":"correct horse"}',
    );
    const other = parseFragment(`#${'A'.repeat(21)}Q.${KEY}`);
    if (!other) throw new Error('unparsed');
    expect(() => openBlob(other, blob)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    if (!link) throw new Error('unparsed');
    const ct = Uint8Array.from(Buffer.from(blob.ct, 'base64url'));
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => openBlob(link, { ...blob, ct: toBase64Url(ct) } as EncryptedBlob)).toThrow();
  });
});

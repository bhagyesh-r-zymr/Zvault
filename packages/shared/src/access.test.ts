import { describe, expect, it } from 'vitest';
import { PutGrantRequest, MemberKeyWrap, holdsKey, levelAtLeast } from './index.js';

const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64url');
const wrap = (ctBytes: number) => ({
  recipientId: '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d',
  recipientPublicKey: b64(32),
  wrapperPublicKey: b64(32),
  ephemeralPublicKey: b64(32),
  blob: {
    v: 1,
    alg: 'xchacha20poly1305',
    kid: 'member-key-wrap',
    nonce: b64(24),
    ct: b64(ctBytes),
  },
});

describe('access levels', () => {
  it('orders manage > edit > use > needs_approval > none', () => {
    expect(levelAtLeast('manage', 'edit')).toBe(true);
    expect(levelAtLeast('use', 'edit')).toBe(false);
    expect(levelAtLeast('needs_approval', 'use')).toBe(false);
    expect(['manage', 'edit', 'use'].every((l) => holdsKey(l as never))).toBe(true);
    expect(holdsKey('needs_approval')).toBe(false);
  });
});

describe('MemberKeyWrap', () => {
  it('accepts exactly a wrapped 32-byte key', () => {
    expect(MemberKeyWrap.safeParse(wrap(48)).success).toBe(true);
    expect(MemberKeyWrap.safeParse(wrap(64)).success).toBe(false);
  });

  it('rejects the owner-grant kid', () => {
    const w = wrap(48);
    expect(MemberKeyWrap.safeParse({ ...w, blob: { ...w.blob, kid: 'account' } }).success).toBe(
      false,
    );
  });
});

describe('PutGrantRequest', () => {
  it('defaults to no end date', () => {
    const g = PutGrantRequest.parse({
      principal: { type: 'group', id: '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d' },
      level: 'edit',
    });
    expect(g.expiresAt).toBeNull();
  });
});

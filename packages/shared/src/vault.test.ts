import { describe, expect, it } from 'vitest';
import { ItemRecord, MAX_ITEM_CT_CHARS, PutItemRequest, SyncItemsQuery } from './index.js';

const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64url');
const VAULT = '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d';
const ITEM = '1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e';
const blob = (kid: string, bytes: number) => ({
  v: 1,
  alg: 'xchacha20poly1305',
  kid,
  nonce: b64(24),
  ct: b64(bytes),
});

describe('PutItemRequest', () => {
  const put = { baseRevision: 0, encryptedKey: blob(VAULT, 48), encryptedData: blob(ITEM, 272) };

  it('accepts a wrapped key and sealed data', () => {
    expect(PutItemRequest.safeParse(put).success).toBe(true);
  });

  it('rejects a key blob that is not a wrapped 32-byte key', () => {
    expect(PutItemRequest.safeParse({ ...put, encryptedKey: blob(VAULT, 32) }).success).toBe(false);
  });

  it('rejects oversized items', () => {
    const huge = { ...blob(ITEM, 0), ct: 'A'.repeat(MAX_ITEM_CT_CHARS + 1) };
    expect(PutItemRequest.safeParse({ ...put, encryptedData: huge }).success).toBe(false);
  });
});

describe('ItemRecord', () => {
  const base = {
    id: ITEM,
    vaultId: VAULT,
    revision: 2,
    seq: 5,
    updatedAt: new Date().toISOString(),
  };

  it('accepts tombstones without ciphertext', () => {
    expect(ItemRecord.parse({ ...base, deleted: true }).deleted).toBe(true);
  });

  it('requires ciphertext on live items', () => {
    expect(ItemRecord.safeParse({ ...base, deleted: false }).success).toBe(false);
  });
});

describe('SyncItemsQuery', () => {
  it('defaults to a full sync and caps the page size', () => {
    expect(SyncItemsQuery.parse({})).toEqual({ since: 0, limit: 500 });
    expect(SyncItemsQuery.safeParse({ limit: '10000' }).success).toBe(false);
  });
});

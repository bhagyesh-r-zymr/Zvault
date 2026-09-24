import { describe, expect, it } from 'vitest';
import {
  EnvironmentMeta,
  formatSecretPath,
  parseSecretPath,
  ProjectEntry,
  PutSecretRequest,
  SecretMeta,
  slugify,
} from './index.js';

const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64url');
const PROJECT = '0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d';
const SECRET = '1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e';
const ENV = '2d7c6e5a-7f3b-4c4d-8e9f-8a7b6c5d4e3f';
const blob = (kid: string, bytes: number) => ({
  v: 1,
  alg: 'xchacha20poly1305',
  kid,
  nonce: b64(24),
  ct: b64(bytes),
});

describe('secret paths', () => {
  it('parses paths with and without a folder', () => {
    expect(parseSecretPath('zv://payments-api/production/billing/STRIPE_SECRET_KEY')).toEqual({
      project: 'payments-api',
      environment: 'production',
      folder: 'billing',
      key: 'STRIPE_SECRET_KEY',
    });
    expect(parseSecretPath('zv://payments-api/development/DATABASE_URL')).toEqual({
      project: 'payments-api',
      environment: 'development',
      folder: null,
      key: 'DATABASE_URL',
    });
  });

  it('rejects malformed paths', () => {
    for (const bad of [
      'payments-api/production/KEY',
      'zv://payments-api/KEY',
      'zv://Payments/production/KEY',
      'zv://p/production/a/b/KEY',
      'zv://p/production/1KEY',
      'zv://p/production/KEY/',
    ]) {
      expect(parseSecretPath(bad), bad).toBeNull();
    }
  });

  it('round-trips through formatSecretPath', () => {
    for (const path of ['zv://a/b/c/D', 'zv://a/b/D']) {
      expect(formatSecretPath(parseSecretPath(path)!)).toBe(path);
    }
  });

  it('slugifies display names', () => {
    expect(slugify('Payments API')).toBe('payments-api');
    expect(slugify('  QA  sandbox!! ')).toBe('qa-sandbox');
    expect(slugify('Café')).toBe('cafe');
  });
});

describe('plaintext metadata', () => {
  it('defaults folder, tags and inheritance', () => {
    expect(SecretMeta.parse({ name: 'Stripe', key: 'STRIPE_KEY' })).toEqual({
      name: 'Stripe',
      key: 'STRIPE_KEY',
      folderId: null,
      tags: [],
    });
    const env = EnvironmentMeta.parse({ name: 'QA', slug: 'qa', kind: 'custom', position: 3 });
    expect(env.inheritsFrom).toBeNull();
  });

  it('rejects tags with a leading #', () => {
    expect(SecretMeta.safeParse({ name: 'x', key: 'X', tags: ['#payments'] }).success).toBe(false);
  });
});

describe('PutSecretRequest', () => {
  it('accepts values per environment and null to clear one', () => {
    const put = PutSecretRequest.parse({
      baseRevision: 0,
      encryptedMeta: blob(SECRET, 272),
      values: { [ENV]: blob(ENV, 272), [PROJECT]: null },
    });
    expect(Object.keys(put.values)).toHaveLength(2);
  });

  it('rejects values keyed by something other than an environment id', () => {
    const put = { baseRevision: 0, encryptedMeta: blob(SECRET, 272), values: { dev: null } };
    expect(PutSecretRequest.safeParse(put).success).toBe(false);
  });
});

describe('ProjectEntry', () => {
  const base = {
    id: SECRET,
    projectId: PROJECT,
    revision: 1,
    seq: 1,
    updatedAt: new Date().toISOString(),
  };

  it('parses live secrets and tombstones', () => {
    const live = ProjectEntry.parse({
      ...base,
      type: 'secret',
      deleted: false,
      encryptedMeta: blob(SECRET, 272),
      values: [],
    });
    expect(live.deleted).toBe(false);
    expect(ProjectEntry.parse({ ...base, type: 'folder', deleted: true }).deleted).toBe(true);
  });

  it('lets an environment omit the caller’s key', () => {
    const env = ProjectEntry.parse({
      ...base,
      type: 'environment',
      deleted: false,
      encryptedMeta: blob(SECRET, 272),
      encryptedKey: null,
    });
    expect(env.type).toBe('environment');
  });
});

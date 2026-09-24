import { describe, expect, it } from 'vitest';
import { Email, SignupVerifyRequest, normalizeEmail } from './index.js';

describe('Email', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(Email.parse('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeEmail(' Bob@X.io')).toBe('bob@x.io');
  });

  it('rejects invalid addresses', () => {
    expect(Email.safeParse('not-an-email').success).toBe(false);
    expect(Email.safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
  });
});

describe('SignupVerifyRequest', () => {
  it('accepts exactly six digits', () => {
    expect(SignupVerifyRequest.safeParse({ email: 'a@b.co', code: '012345' }).success).toBe(true);
    expect(SignupVerifyRequest.safeParse({ email: 'a@b.co', code: '12345' }).success).toBe(false);
    expect(SignupVerifyRequest.safeParse({ email: 'a@b.co', code: '12345a' }).success).toBe(false);
  });
});

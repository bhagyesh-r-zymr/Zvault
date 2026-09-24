import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('applies defaults and splits CORS origins', () => {
    const env = loadEnv({ CORS_ORIGINS: 'http://a.test, tauri://localhost' });
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'tauri://localhost']);
    expect(env.MAIL_TRANSPORT).toBe('log');
    expect(env.DATABASE_URL).toMatch(/^postgres:/);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow(/Invalid environment/);
  });

  it('refuses development fallbacks in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL[\s\S]*SERVER_SECRET[\s\S]*MAIL_TRANSPORT/,
    );
  });

  it('accepts a complete production config', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db.internal:5432/zvault',
      DATABASE_SSL: 'true',
      SERVER_SECRET: 'x'.repeat(48),
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'email-smtp.us-east-1.amazonaws.com',
    });
    expect(env.DATABASE_SSL).toBe(true);
    expect(env.SMTP_SECURE).toBe(false);
  });

  it('treats blank values as unset', () => {
    const env = loadEnv({ SERVER_SECRET: '', SMTP_USER: ' ' });
    expect(env.SERVER_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.SMTP_USER).toBeUndefined();
  });

  it('refuses plaintext SMTP in production', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@db.internal:5432/zvault',
        SERVER_SECRET: 'x'.repeat(48),
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_ALLOW_INSECURE: 'true',
      }),
    ).toThrow(/SMTP_ALLOW_INSECURE/);
  });

  it('requires an SMTP host when sending real mail', () => {
    expect(() => loadEnv({ MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
  });
});

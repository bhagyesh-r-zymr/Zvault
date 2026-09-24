import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 32 random bytes, base64url. In AWS this comes from Secrets Manager. */
  TWO_FACTOR_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes of unpadded base64url')
      .optional(),
  ),
  TWO_FACTOR_ISSUER: z.string().min(1).max(64).default('Zvault'),
});

export interface TwoFactorConfig {
  /** Root key; per-purpose keys are derived from it with HKDF. */
  masterKey: Buffer;
  issuer: string;
}

export const TWO_FACTOR_CONFIG = Symbol('TWO_FACTOR_CONFIG');

/**
 * Reads 2FA settings. Outside production a missing key is replaced by a random
 * one, which means enrollments do not survive a restart; production refuses
 * to boot without a key.
 */
export function loadTwoFactorConfig(source: NodeJS.ProcessEnv = process.env): TwoFactorConfig {
  const result = ConfigSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid 2FA configuration:\n${z.prettifyError(result.error)}`);
  }
  const { NODE_ENV, TWO_FACTOR_ENCRYPTION_KEY, TWO_FACTOR_ISSUER } = result.data;
  if (TWO_FACTOR_ENCRYPTION_KEY) {
    return {
      masterKey: Buffer.from(TWO_FACTOR_ENCRYPTION_KEY, 'base64url'),
      issuer: TWO_FACTOR_ISSUER,
    };
  }
  if (NODE_ENV === 'production') {
    throw new Error('TWO_FACTOR_ENCRYPTION_KEY is required in production');
  }
  if (NODE_ENV === 'development') {
    new Logger('TwoFactor').warn('TWO_FACTOR_ENCRYPTION_KEY not set; using an ephemeral key');
  }
  return { masterKey: randomBytes(32), issuer: TWO_FACTOR_ISSUER };
}

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type pg from 'pg';
import type { Env } from '../config/env.js';

/** How long a fetched password is reused before asking Secrets Manager again. */
const PASSWORD_CACHE_MS = 30_000;

/**
 * Reads the database password from a Secrets Manager secret each time the pool
 * opens a connection (cached briefly), so a scheduled rotation takes effect
 * without restarting the API. Open connections are unaffected by rotation.
 */
export function secretsManagerPassword(
  secretArn: string,
  client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({}),
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { password: string; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < PASSWORD_CACHE_MS) return cached.password;
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const { password } = JSON.parse(out.SecretString ?? '{}') as { password?: unknown };
    if (typeof password !== 'string' || password === '') {
      throw new Error('The database credentials secret has no password.');
    }
    cached = { password, at: now() };
    return password;
  };
}

/** node-postgres settings shared by the API and the migration task. */
export function poolConfig(env: Env, max: number): pg.PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    ...(env.DATABASE_CREDENTIALS_ARN
      ? { password: secretsManagerPassword(env.DATABASE_CREDENTIALS_ARN) }
      : {}),
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max,
  };
}

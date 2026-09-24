import { z } from 'zod';

/** Development-only fallbacks. Production must set every one explicitly. */
const DEV_DEFAULTS = {
  DATABASE_URL: 'postgres://zvault:zvault@localhost:5432/zvault',
  SERVER_SECRET: 'dev-only-server-secret-change-me-0000000000',
} as const;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),

    /** Reverse-proxy hops in front of the API (1 behind the ALB), so rate limits key on the client IP. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    DATABASE_URL: z.url().optional(),
    /** Alternative to DATABASE_URL, as set by the CDK stack (password from Secrets Manager). */
    DATABASE_HOST: z.string().min(1).optional(),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DATABASE_NAME: z.string().min(1).optional(),
    DATABASE_USER: z.string().min(1).optional(),
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_SSL: z.stringbool().default(false),
    /**
     * Secrets Manager secret holding the database password (as set by the AWS
     * stack). Read on connect, so password rotation needs no restart.
     */
    DATABASE_CREDENTIALS_ARN: z.string().startsWith('arn:').optional(),

    /** Keys the HMACs over verification codes and decoy logins. 32+ random chars. */
    SERVER_SECRET: z.string().min(32).optional(),

    /**
     * `log` prints emails to the server log (development only); `smtp` sends
     * through any SMTP provider; `ses` uses the Amazon SES API with the task's
     * IAM role (no SMTP credentials).
     */
    MAIL_TRANSPORT: z.enum(['log', 'smtp', 'ses']).default('log'),
    /** Sender for `ses`; defaults to MAIL_FROM. */
    SES_FROM_ADDRESS: z.string().min(3).optional(),
    SES_CONFIGURATION_SET: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(3).default('Zvault <no-reply@localhost>'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    /** true for implicit TLS (port 465); false upgrades with STARTTLS, which is then required. */
    SMTP_SECURE: z.stringbool().default(false),
    /** Development only: allow plaintext SMTP (e.g. a local Mailpit). Refused in production. */
    SMTP_ALLOW_INSECURE: z.stringbool().default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === 'production';
    const need = (key: keyof typeof env, why: string) => {
      if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: why });
    };
    if (prod) {
      if (env.DATABASE_URL === undefined && env.DATABASE_HOST === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'DATABASE_URL or DATABASE_HOST is required in production',
        });
      }
      need('SERVER_SECRET', 'is required in production');
      if (env.SMTP_ALLOW_INSECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_ALLOW_INSECURE'],
          message: 'must be false in production',
        });
      }
      if (env.MAIL_TRANSPORT === 'log') {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_TRANSPORT'],
          message: 'must be smtp or ses in production',
        });
      }
    }
    if (env.MAIL_TRANSPORT === 'smtp') need('SMTP_HOST', 'is required when MAIL_TRANSPORT=smtp');
  })
  .transform((env) => ({
    ...env,
    DATABASE_URL: env.DATABASE_URL ?? databaseUrlFromParts(env) ?? DEV_DEFAULTS.DATABASE_URL,
    SERVER_SECRET: env.SERVER_SECRET ?? DEV_DEFAULTS.SERVER_SECRET,
  }));

function databaseUrlFromParts(env: {
  DATABASE_HOST?: string | undefined;
  DATABASE_PORT: number;
  DATABASE_NAME?: string | undefined;
  DATABASE_USER?: string | undefined;
  DATABASE_PASSWORD?: string | undefined;
}): string | undefined {
  if (!env.DATABASE_HOST) return undefined;
  const url = new URL('postgres://placeholder');
  url.hostname = env.DATABASE_HOST;
  url.port = String(env.DATABASE_PORT);
  url.pathname = `/${env.DATABASE_NAME ?? 'zvault'}`;
  url.username = env.DATABASE_USER ?? '';
  url.password = env.DATABASE_PASSWORD ?? '';
  return url.toString();
}

/** Blank lines in `.env` (e.g. `SMTP_USER=`) mean "not set". */
const withoutBlanks = (source: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));

export type Env = z.infer<typeof EnvSchema>;

/** Parses the process environment once at boot and fails fast on bad config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(withoutBlanks(source));
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

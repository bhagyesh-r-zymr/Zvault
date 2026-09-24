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

    DATABASE_URL: z.url().optional(),
    DATABASE_SSL: z.stringbool().default(false),

    /** Keys the HMACs over verification codes and decoy logins. 32+ random chars. */
    SERVER_SECRET: z.string().min(32).optional(),
    SESSION_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 30)
      .default(12 * 60),

    /** `log` prints emails to the server log (development only); `smtp` sends them. */
    MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
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
      need('DATABASE_URL', 'is required in production');
      need('SERVER_SECRET', 'is required in production');
      if (env.SMTP_ALLOW_INSECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_ALLOW_INSECURE'],
          message: 'must be false in production',
        });
      }
      if (env.MAIL_TRANSPORT !== 'smtp') {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_TRANSPORT'],
          message: 'must be smtp in production',
        });
      }
    }
    if (env.MAIL_TRANSPORT === 'smtp') need('SMTP_HOST', 'is required when MAIL_TRANSPORT=smtp');
  })
  .transform((env) => ({
    ...env,
    DATABASE_URL: env.DATABASE_URL ?? DEV_DEFAULTS.DATABASE_URL,
    SERVER_SECRET: env.SERVER_SECRET ?? DEV_DEFAULTS.SERVER_SECRET,
  }));

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

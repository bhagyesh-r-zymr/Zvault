import { z } from 'zod';

export const API_VERSION = 'v1' as const;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const CryptoMetaResponse = z.object({
  cryptoVersion: z.number().int(),
  kdfMinimums: z.object({ memoryKib: z.number().int(), iterations: z.number().int() }),
  kdfDefaults: z.object({
    alg: z.literal('argon2id'),
    memoryKib: z.number().int(),
    iterations: z.number().int(),
    parallelism: z.number().int(),
  }),
  aead: z.literal('xchacha20poly1305'),
});
export type CryptoMetaResponse = z.infer<typeof CryptoMetaResponse>;

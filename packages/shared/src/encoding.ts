import { z } from 'zod';

/** Unpadded base64url, the only binary encoding used on the wire. */
export const Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/, 'must be unpadded base64url')
  .brand<'Base64Url'>();
export type Base64Url = z.infer<typeof Base64Url>;

/** Base64url of exactly `bytes` decoded bytes. */
export const base64UrlOfLength = (bytes: number) =>
  Base64Url.refine((s) => s.length === Math.ceil((bytes * 4) / 3), {
    message: `must encode exactly ${bytes} bytes`,
  });

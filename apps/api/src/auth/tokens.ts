import { createHash, createHmac, randomBytes } from 'node:crypto';

/** A 256-bit random bearer token, base64url. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are stored only as their SHA-256, so a database leak can't be replayed. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** HMAC-SHA256 keyed with `SERVER_SECRET`, over length-prefixed parts. */
export function hmac(secret: string, ...parts: string[]): Buffer {
  const mac = createHmac('sha256', secret);
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    mac.update(len).update(bytes);
  }
  return mac.digest();
}

export const minutesFromNow = (minutes: number, now = new Date()): Date =>
  new Date(now.getTime() + minutes * 60_000);

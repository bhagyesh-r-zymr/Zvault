import { z } from 'zod';
import { Email } from './auth.js';

/** Trims and collapses whitespace; strips control characters so notices stay one line per field. */
const cleanText = (max: number) =>
  z
    .string()
    .transform((s) =>
      s
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().max(max));

/** POST /v1/waitlist, sent by the landing page form. */
export const JoinWaitlistRequest = z.object({
  name: cleanText(100).pipe(z.string().min(1, { message: 'is required' })),
  email: Email,
  /** Optional: their team or why they want to try Zvault. */
  note: cleanText(500).optional().default(''),
  /** Honeypot. Hidden from people; bots that fill it are dropped silently. */
  website: z.string().max(200).optional().default(''),
});
export type JoinWaitlistRequest = z.output<typeof JoinWaitlistRequest>;

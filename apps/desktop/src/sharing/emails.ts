import { SHARE_LIMITS, ShareEmail } from '@zvault/shared';

/** Splits what the user typed into normalized emails, or says what is wrong. */
export function parseEmails(text: string): { emails: string[] } | { error: string } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: 'Add at least one email.' };
  const emails: string[] = [];
  for (const part of parts) {
    const parsed = ShareEmail.safeParse(part);
    if (!parsed.success) return { error: `${part} is not an email address.` };
    if (!emails.includes(parsed.data)) emails.push(parsed.data);
  }
  if (emails.length > SHARE_LIMITS.maxAllowedEmails) {
    return { error: `A link can name at most ${SHARE_LIMITS.maxAllowedEmails} people.` };
  }
  return { emails };
}

import { describe, expect, it } from 'vitest';
import { parseEmails } from './emails.js';

describe('parseEmails', () => {
  it('splits on commas, spaces and new lines, normalizes and drops repeats', () => {
    expect(parseEmails(' A@x.com, b@y.org\n a@X.com ; c@z.io ')).toEqual({
      emails: ['a@x.com', 'b@y.org', 'c@z.io'],
    });
  });

  it('says what is wrong', () => {
    expect(parseEmails('  ')).toEqual({ error: 'Add at least one email.' });
    expect(parseEmails('a@x.com, nope')).toEqual({ error: 'nope is not an email address.' });
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.com`).join(',');
    expect(parseEmails(many)).toHaveProperty('error');
  });
});

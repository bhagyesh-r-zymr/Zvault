import { describe, expect, it } from 'vitest';
import { SharedItemPayload, secretSharePayload } from './sharing.js';

describe('secretSharePayload', () => {
  it('puts the value where older apps look for it and keeps where it came from', () => {
    const payload = secretSharePayload({
      name: 'Database URL',
      key: 'DATABASE_URL',
      value: 'postgres://u:p@db/app',
      note: 'Read replica',
      project: 'Payments API',
      environment: 'Staging',
    });
    expect(payload).toEqual({
      v: 1,
      title: 'Database URL',
      password: 'postgres://u:p@db/app',
      notes: 'Read replica',
      secret: { key: 'DATABASE_URL', project: 'Payments API', environment: 'Staging' },
    });
    expect(SharedItemPayload.parse(payload)).toEqual(payload);
  });

  it('falls back to the key as the title and leaves out an empty note', () => {
    const payload = secretSharePayload({
      name: '',
      key: 'API_TOKEN',
      value: 't',
      note: '',
      project: 'P',
      environment: 'E',
    });
    expect(payload.title).toBe('API_TOKEN');
    expect(payload).not.toHaveProperty('notes');
  });

  it('still parses a vault item without secret details', () => {
    expect(SharedItemPayload.parse({ v: 1, title: 'Wi-Fi', password: 'x' }).secret).toBeUndefined();
  });
});

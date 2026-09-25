import 'reflect-metadata';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitlist } from '../src/db/schema.js';
import { WaitlistService } from '../src/waitlist/waitlist.service.js';
import { ENV } from '../src/config/config.module.js';
import type { Env } from '../src/config/env.js';
import { createHarness, type Harness } from './harness.js';

const OWNER = 'owner@example.com';
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('Waitlist (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    // The harness env has no owner; set one so notices are sent.
    (h.app.get<Env>(ENV) as { WAITLIST_OWNER_EMAIL?: string }).WAITLIST_OWNER_EMAIL = OWNER;
    expect(h.app.get(WaitlistService)).toBeDefined();
  });

  beforeEach(async () => {
    await h.db.delete(waitlist);
    h.mailer.sent.length = 0;
  });

  afterAll(async () => {
    await h.close();
  });

  const join = (body: object) => request(h.server).post('/v1/waitlist').send(body);

  it('stores an email-only sign-up and emails the owner', async () => {
    await join({ email: ' Ada@Example.COM' }).expect(204);
    const rows = await h.db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: '',
      email: 'ada@example.com',
      note: '',
      status: 'pending',
    });
    await flush();
    const notice = h.mailer.lastTo(OWNER);
    expect(notice?.subject).toContain('ada@example.com');
    expect(notice?.html).toContain('ada@example.com');
    // Nothing goes to the joiner (SES sandbox would drop it anyway).
    expect(h.mailer.lastTo('ada@example.com')).toBeUndefined();
  });

  it('still accepts a name and note from older pages', async () => {
    await join({ name: '  Ada   Lovelace ', email: 'ada@example.com', note: 'Platform' }).expect(
      204,
    );
    const [row] = await h.db.select().from(waitlist);
    expect(row).toMatchObject({ name: 'Ada Lovelace', note: 'Platform' });
  });

  it('answers the same for a repeat email and does not change or re-notify', async () => {
    await join({ email: 'ada@example.com' }).expect(204);
    await join({ name: 'Mallory', email: 'ADA@example.com', note: 'changed' }).expect(204);
    const rows = await h.db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('');
    await flush();
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('drops honeypot submissions silently', async () => {
    await join({ email: 'bot@example.com', website: 'http://spam' }).expect(204);
    expect(await h.db.select().from(waitlist)).toHaveLength(0);
    await flush();
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('rejects invalid forms', async () => {
    await join({}).expect(400);
    await join({ email: 'not-an-email' }).expect(400);
    await join({ email: '<b>x</b>@example.com' }).expect(400);
    await join({ name: 'A'.repeat(101), email: 'a@example.com' }).expect(400);
    await join({ email: 'a@example.com', note: 'n'.repeat(501) }).expect(400);
    expect(await h.db.select().from(waitlist)).toHaveLength(0);
  });
});

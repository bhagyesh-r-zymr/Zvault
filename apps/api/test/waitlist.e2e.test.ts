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

  it('stores a sign-up and emails the owner', async () => {
    await join({
      name: '  Ada   Lovelace ',
      email: ' Ada@Example.COM',
      note: 'Platform team',
    }).expect(204);
    const rows = await h.db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      note: 'Platform team',
      status: 'pending',
    });
    await flush();
    const notice = h.mailer.lastTo(OWNER);
    expect(notice?.subject).toContain('Ada Lovelace');
    expect(notice?.text).toContain('ada@example.com');
    // Nothing goes to the joiner (SES sandbox would drop it anyway).
    expect(h.mailer.lastTo('ada@example.com')).toBeUndefined();
  });

  it('answers the same for a repeat email and does not change or re-notify', async () => {
    await join({ name: 'Ada', email: 'ada@example.com' }).expect(204);
    await join({ name: 'Mallory', email: 'ADA@example.com', note: 'changed' }).expect(204);
    const rows = await h.db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Ada');
    await flush();
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('drops honeypot submissions silently', async () => {
    await join({ name: 'Bot', email: 'bot@example.com', website: 'http://spam' }).expect(204);
    expect(await h.db.select().from(waitlist)).toHaveLength(0);
    await flush();
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('escapes what the visitor typed in the HTML notice', async () => {
    await join({ name: '<b>x</b>', email: 'x@example.com', note: '<script>' }).expect(204);
    await flush();
    const html = h.mailer.lastTo(OWNER)!.html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
  });

  it('rejects invalid forms', async () => {
    await join({ name: '', email: 'a@example.com' }).expect(400);
    await join({ name: 'A', email: 'not-an-email' }).expect(400);
    await join({ name: 'A'.repeat(101), email: 'a@example.com' }).expect(400);
    await join({ name: 'A', email: 'a@example.com', note: 'n'.repeat(501) }).expect(400);
    expect(await h.db.select().from(waitlist)).toHaveLength(0);
  });
});

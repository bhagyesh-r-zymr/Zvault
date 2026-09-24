import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { SharingKeyResponse } from '@zvault/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts } from '../src/db/schema.js';
import { createHarness, signedInAccount, type Harness } from './harness.js';

const rand = (n: number) => randomBytes(n).toString('base64url');

describe('Sharing behind a real session (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects requests without a session', async () => {
    await request(h.server).get('/v1/shares/links').expect(401);
    await request(h.server)
      .get('/v1/shares/links')
      .set('Authorization', `Bearer ${'A'.repeat(43)}`)
      .expect(401);
  });

  it('serves a signed-in account', async () => {
    const alice = await signedInAccount(h);
    const res = await request(h.server).get('/v1/shares/links').set(alice.headers).expect(200);
    expect(res.body).toEqual({ links: [] });
  });

  it('acts as the session account, with its email', async () => {
    const alice = await signedInAccount(h);
    const publicKey = Buffer.alloc(32, 9).toString('base64url');
    await request(h.server)
      .put('/v1/shares/keys/me')
      .set(alice.headers)
      .send({ publicKey })
      .expect((r) => expect(r.status).toBeLessThan(300));
    const mine = SharingKeyResponse.parse(
      (await request(h.server).get('/v1/shares/keys/me').set(alice.headers).expect(200)).body,
    );
    expect(mine.publicKey).toBe(publicKey);
    expect(mine.email).toMatch(/^account-\d+-\d+@example\.com$/);
  });

  it('emails the recipient of a user share', async () => {
    const alice = await signedInAccount(h);
    const bob = await signedInAccount(h);
    const [bobRow] = await h.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, bob.id));
    const aliceKey = rand(32);
    const bobKey = rand(32);
    await request(h.server)
      .put('/v1/shares/keys/me')
      .set(alice.headers)
      .send({ publicKey: aliceKey });
    await request(h.server).put('/v1/shares/keys/me').set(bob.headers).send({ publicKey: bobKey });

    await request(h.server)
      .post('/v1/shares/users')
      .set(alice.headers)
      .send({
        id: rand(16),
        recipientEmail: bobRow!.email,
        recipientPublicKey: bobKey,
        senderPublicKey: aliceKey,
        ephemeralPublicKey: rand(32),
        blob: { v: 1, alg: 'xchacha20poly1305', kid: 'share-box', nonce: rand(24), ct: rand(64) },
      })
      .expect(201);

    const mail = h.mailer.lastTo(bobRow!.email);
    expect(mail?.subject).toMatch(/shared an item with you/);
    expect(mail?.text).toContain('Sharing');
  });
});

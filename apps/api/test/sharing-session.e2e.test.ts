import 'reflect-metadata';
import { SharingKeyResponse } from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, signedInAccount, type Harness } from './harness.js';

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
});

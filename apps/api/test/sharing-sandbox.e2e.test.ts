import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { CreateShareLinkResponse } from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitlist } from '../src/db/schema.js';
import { createHarness, signedInAccount, type Harness } from './harness.js';

const rand = (n: number) => randomBytes(n).toString('base64url');

describe('Email-restricted links in SES sandbox mode (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { MAIL_SANDBOX: 'true' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('warns the sender about recipients SES may not reach', async () => {
    const alice = await signedInAccount(h, 'alice@example.com');
    await signedInAccount(h, 'bob@example.com');
    await h.db.insert(waitlist).values([
      { email: 'carol@example.com', name: 'Carol', status: 'verified' },
      { email: 'dave@example.com', name: 'Dave', status: 'pending' },
    ]);
    const token = randomBytes(32);
    const res = await request(h.server)
      .post('/v1/shares/links')
      .set(alice.headers)
      .send({
        id: rand(16),
        verifier: createHash('sha256').update(token).digest().toString('base64url'),
        blob: { v: 1, alg: 'xchacha20poly1305', kid: 'share-link', nonce: rand(24), ct: rand(64) },
        allowedEmails: [
          'Bob@example.com',
          'carol@example.com',
          'dave@example.com',
          'eve@example.com',
        ],
      })
      .expect(201);
    expect(CreateShareLinkResponse.parse(res.body).unverifiedEmails).toEqual([
      'dave@example.com',
      'eve@example.com',
    ]);
  });
});

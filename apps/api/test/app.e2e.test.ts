import { CryptoMetaResponse, HealthResponse } from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

describe('API (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('GET /v1/health reports ok', async () => {
    const res = await request(h.server).get('/v1/health').expect(200);
    expect(HealthResponse.parse(res.body).status).toBe('ok');
  });

  it('GET /v1/meta/crypto matches the shared contract', async () => {
    const res = await request(h.server).get('/v1/meta/crypto').expect(200);
    expect(CryptoMetaResponse.parse(res.body).aead).toBe('xchacha20poly1305');
  });

  it('sets security headers', async () => {
    const res = await request(h.server).get('/v1/health');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await request(h.server)
      .get('/v1/health')
      .set('Origin', 'http://localhost:1420');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:1420');

    const denied = await request(h.server).get('/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

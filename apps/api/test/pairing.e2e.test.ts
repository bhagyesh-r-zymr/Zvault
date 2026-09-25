import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  CreatePairingResponse,
  ListDevicesResponse,
  PairingResultResponse,
  PairingView,
  type DeviceInfo,
  PairingGrant,
} from '@zvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, signedInAccount, type Harness } from './harness.js';

const phone: DeviceInfo = { name: 'Pixel 9', platform: 'android', appVersion: '0.1.0' };
const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
const grant: PairingGrant = PairingGrant.parse({
  ephemeralPublicKey: b64(32),
  nonce: b64(24),
  ct: b64(96),
});

describe('Pairing (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function newPairing(headers: { Authorization: string }) {
    const claimToken = b64(32);
    const res = await request(h.server)
      .post('/v1/pairings')
      .set(headers)
      .send({ claimToken })
      .expect(201);
    return { id: CreatePairingResponse.parse(res.body).id, claimToken };
  }

  const claim = (id: string, claimToken: string, publicKey = b64(32)) =>
    request(h.server)
      .post(`/v1/pairings/${id}/claim`)
      .send({ claimToken, publicKey, device: phone });

  const result = (id: string, claimToken: string) =>
    request(h.server).post(`/v1/pairings/${id}/result`).send({ claimToken });

  it('creating a pairing needs a signed-in device', async () => {
    await request(h.server)
      .post('/v1/pairings')
      .send({ claimToken: b64(32) })
      .expect(401);
  });

  it('adds a phone with its own session once the Mac allows it', async () => {
    const mac = await signedInAccount(h);
    const { id, claimToken } = await newPairing(mac.headers);
    const phoneKey = b64(32);

    const waiting = PairingView.parse(
      (await request(h.server).get(`/v1/pairings/${id}`).set(mac.headers).expect(200)).body,
    );
    expect(waiting).toMatchObject({ status: 'waiting', device: null, publicKey: null });

    await claim(id, claimToken, phoneKey).expect(204);
    expect(PairingResultResponse.parse((await result(id, claimToken).expect(200)).body)).toEqual({
      status: 'waiting',
    });
    const claimed = PairingView.parse(
      (await request(h.server).get(`/v1/pairings/${id}`).set(mac.headers).expect(200)).body,
    );
    expect(claimed).toMatchObject({ status: 'claimed', device: phone, publicKey: phoneKey });

    await request(h.server)
      .post(`/v1/pairings/${id}/approve`)
      .set(mac.headers)
      .send({ grant })
      .expect(204);

    const done = PairingResultResponse.parse((await result(id, claimToken).expect(200)).body);
    if (done.status !== 'approved') throw new Error('expected approval');
    expect(done.grant).toEqual(grant);

    // The phone's token is a real session, listed on the Mac's Devices screen.
    const devices = ListDevicesResponse.parse(
      (await request(h.server).get('/v1/devices').set(mac.headers).expect(200)).body,
    ).devices;
    expect(devices.map((d) => d.device.name)).toContain('Pixel 9');
    await request(h.server)
      .get('/v1/auth/session')
      .set({ Authorization: `Bearer ${done.sessionToken}` })
      .expect(200);

    // Collected once, then gone.
    await result(id, claimToken).expect(404);
  });

  it('a QR code can be claimed only once, and only with its token', async () => {
    const mac = await signedInAccount(h);
    const { id, claimToken } = await newPairing(mac.headers);
    await claim(id, b64(32)).expect(404);
    await claim(id, claimToken).expect(204);
    await claim(id, claimToken).expect(409);
    await result(id, b64(32)).expect(404);
  });

  it('tells the phone when the Mac says no', async () => {
    const mac = await signedInAccount(h);
    const { id, claimToken } = await newPairing(mac.headers);
    await claim(id, claimToken).expect(204);
    await request(h.server).post(`/v1/pairings/${id}/deny`).set(mac.headers).expect(204);
    await request(h.server)
      .post(`/v1/pairings/${id}/approve`)
      .set(mac.headers)
      .send({ grant })
      .expect(409);
    expect((await result(id, claimToken).expect(200)).body).toEqual({ status: 'denied' });
    await result(id, claimToken).expect(404);
  });

  it('cannot approve before a phone claims it', async () => {
    const mac = await signedInAccount(h);
    const { id } = await newPairing(mac.headers);
    await request(h.server)
      .post(`/v1/pairings/${id}/approve`)
      .set(mac.headers)
      .send({ grant })
      .expect(409);
  });

  it('another account cannot see or approve the pairing', async () => {
    const mac = await signedInAccount(h);
    const other = await signedInAccount(h);
    const { id, claimToken } = await newPairing(mac.headers);
    await claim(id, claimToken).expect(204);
    await request(h.server).get(`/v1/pairings/${id}`).set(other.headers).expect(404);
    await request(h.server)
      .post(`/v1/pairings/${id}/approve`)
      .set(other.headers)
      .send({ grant })
      .expect(404);
  });
});

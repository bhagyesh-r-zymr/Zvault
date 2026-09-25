import { describe, expect, it, vi } from 'vitest';
import { createPairingClient, groupCode } from './pairing.js';

const ID = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4';

function fakeFetch(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      body === undefined ? new Response(null, { status }) : Response.json(body, { status }),
    ),
  );
}

describe('createPairingClient', () => {
  it('creates a pairing with the claim token and the bearer token', async () => {
    const f = fakeFetch(201, { id: ID, expiresAt: '2026-09-25T10:03:00.000Z' });
    const client = createPairingClient({
      baseUrl: 'https://api.test/',
      getToken: () => 'tok',
      fetch: f,
    });
    await expect(client.create('A'.repeat(43))).resolves.toMatchObject({ id: ID });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/pairings');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(init?.body as string)).toEqual({ claimToken: 'A'.repeat(43) });
  });

  it('explains an expired QR code', async () => {
    const client = createPairingClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: fakeFetch(404, { message: 'Not Found' }),
    });
    await expect(client.get(ID)).rejects.toThrow('This QR code has expired');
  });

  it('refuses to call without a session', async () => {
    const f = fakeFetch(200, {});
    const client = createPairingClient({
      baseUrl: 'https://api.test',
      getToken: () => null,
      fetch: f,
    });
    await expect(client.deny(ID)).rejects.toMatchObject({ status: 401 });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('groupCode', () => {
  it('splits six digits in two', () => {
    expect(groupCode('472918')).toBe('472 918');
  });
});

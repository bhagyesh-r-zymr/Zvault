import { describe, expect, it, vi } from 'vitest';
import { createDevicesClient, DevicesApiError } from './client.js';

const device = {
  id: '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4',
  device: { name: 'Work MacBook', platform: 'macos', appVersion: '0.1.0' },
  createdAt: '2026-09-24T10:00:00.000Z',
  lastSeenAt: '2026-09-24T11:00:00.000Z',
  current: true,
};

function fakeFetch(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      body === undefined ? new Response(null, { status }) : Response.json(body, { status }),
    ),
  );
}

describe('createDevicesClient', () => {
  it('sends the bearer token and validates the list', async () => {
    const f = fakeFetch(200, { devices: [device] });
    const client = createDevicesClient({
      baseUrl: 'https://api.test/',
      getToken: () => 'tok',
      fetch: f,
    });

    await expect(client.list()).resolves.toEqual([device]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/devices');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(init?.credentials).toBe('omit');
  });

  it('rejects a response that does not match the contract', async () => {
    const f = fakeFetch(200, { devices: [{ ...device, id: 'nope' }] });
    const client = createDevicesClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: f,
    });
    await expect(client.list()).rejects.toThrow();
  });

  it('revokes one session and all others', async () => {
    const f = fakeFetch(204);
    const client = createDevicesClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: f,
    });
    await client.revoke(device.id);
    expect(f.mock.calls[0]![0]).toBe(`https://api.test/v1/devices/${device.id}`);
    expect(f.mock.calls[0]![1]?.method).toBe('DELETE');

    const g = fakeFetch(200, { revoked: 2 });
    const client2 = createDevicesClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: g,
    });
    await expect(client2.revokeOthers()).resolves.toBe(2);
    expect(g.mock.calls[0]![1]?.method).toBe('POST');
  });

  it('reports an ended session as signed out', async () => {
    const client = createDevicesClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: fakeFetch(401),
    });
    const err = await client.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevicesApiError);
    expect((err as DevicesApiError).signedOut).toBe(true);
  });

  it('does not call the API without a token', async () => {
    const f = fakeFetch(200, { devices: [] });
    const client = createDevicesClient({
      baseUrl: 'https://api.test',
      getToken: () => null,
      fetch: f,
    });
    await expect(client.list()).rejects.toBeInstanceOf(DevicesApiError);
    expect(f).not.toHaveBeenCalled();
  });
});

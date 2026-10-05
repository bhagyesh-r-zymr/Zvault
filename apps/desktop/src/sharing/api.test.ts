import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { API_URL, ApiError, sharingApi } from './api.js';
import { sharingCore } from './core.js';
import { blob, ID, KEY } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('sharingApi', () => {
  it('sends authenticated JSON and parses the response', async () => {
    const summary = {
      id: ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      maxViews: 1,
      viewCount: 0,
      status: 'active',
    };
    const spy = stubFetch(200, summary);
    const api = sharingApi(() => ({ authorization: 'Bearer t' }));
    const res = await api.createLink({ id: ID, verifier: KEY, blob: blob('share-link') });
    expect(res.unverifiedEmails).toEqual([]);
    expect(res.allowedEmailCount).toBe(0);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${API_URL}/v1/shares/links`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer t',
      'content-type': 'application/json',
    });
  });

  it('covers every route', async () => {
    const spy = stubFetch(200, {});
    const api = sharingApi();
    await api.revokeLink('a').catch(() => undefined);
    await api.removeUserShare('b').catch(() => undefined);
    const paths = spy.mock.calls.map((c) => `${c[1]?.method} ${c[0]}`);
    expect(paths).toEqual([
      `DELETE ${API_URL}/v1/shares/links/a`,
      `DELETE ${API_URL}/v1/shares/users/b`,
    ]);
    stubFetch(200, { links: [] });
    expect(await api.listLinks()).toEqual({ links: [] });
    stubFetch(200, { incoming: [], outgoing: [] });
    expect(await api.listUserShares()).toEqual({ incoming: [], outgoing: [] });
    const key = { userId: 'u', email: 'a@b.co', publicKey: KEY };
    const s = stubFetch(200, key);
    expect(await api.publishKey(KEY)).toEqual(key);
    expect(await api.lookupKey('a+b@b.co')).toEqual(key);
    expect(s.mock.calls[1]?.[0]).toContain('/shares/keys?email=a%2Bb%40b.co');
    const recip = {
      id: ID,
      recipient: { userId: 'u', email: 'a@b.co' },
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    };
    stubFetch(200, recip);
    expect(
      await api.shareWithUser({
        id: ID,
        recipientEmail: 'a@b.co',
        recipientPublicKey: KEY,
        senderPublicKey: KEY,
        ephemeralPublicKey: KEY,
        blob: blob('share-box'),
      }),
    ).toEqual(recip);
  });

  it('throws ApiError with the server message, or a default', async () => {
    stubFetch(403, { message: 'nope' });
    await expect(sharingApi().listLinks()).rejects.toMatchObject({ status: 403, message: 'nope' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>', { status: 502 }))),
    );
    const err = await sharingApi()
      .listLinks()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Request failed (502)');
  });
});

describe('sharingCore', () => {
  it('maps to Rust commands', async () => {
    const calls = mockCore({
      share_link_create: { id: ID },
      sharing_identity: { publicKey: KEY, fingerprint: 'fp' },
      sharing_fingerprint: 'fp',
      share_seal_to: { id: ID },
      share_compose_email: null,
      share_open: '{"v":1,"title":"t"}',
    });
    await sharingCore.createLink({ v: 1, title: 't' }, 'http://s');
    expect(calls).toHaveBeenCalledWith('share_link_create', {
      payload: '{"v":1,"title":"t"}',
      shareOrigin: 'http://s',
    });
    expect(await sharingCore.identity()).toMatchObject({ fingerprint: 'fp' });
    expect(await sharingCore.fingerprint(KEY)).toBe('fp');
    await sharingCore.sealTo(KEY, { v: 1, title: 't' });
    await sharingCore.composeEmail(['a@b.co'], 's', 'b');
    const share = {
      id: ID,
      sender: { userId: 'u', email: 'a@b.co', publicKey: KEY },
      ephemeralPublicKey: KEY,
      blob: blob('share-box'),
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    };
    expect(await sharingCore.open(share)).toBe('{"v":1,"title":"t"}');
    expect(calls).toHaveBeenCalledWith('share_open', {
      share: { id: ID, senderPublicKey: KEY, ephemeralPublicKey: KEY, blob: share.blob },
    });
  });
});

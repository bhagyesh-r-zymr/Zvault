/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { TeamError } from './teamApi.js';
import { TokensApi, tokensCore } from './tokensApi.js';

const id = () => crypto.randomUUID();
const NOW = '2026-01-01T00:00:00.000Z';

function setup(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => respond(init ?? {}));
  const api = new TokensApi(
    { baseUrl: 'https://api.test', accessToken: async () => 'tok' },
    fetchImpl as unknown as typeof fetch,
  );
  return { api, fetchImpl };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const view = () => ({
  id: id(),
  name: 'ci',
  environmentIds: [id()],
  createdBy: { id: id(), email: 'a@b.co' },
  createdAt: NOW,
  expiresAt: NOW,
  lastUsedAt: null,
  stale: false,
});

describe('TokensApi', () => {
  it('lists, creates and revokes tokens', async () => {
    const v = view();
    const { api, fetchImpl } = setup((init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(init.method === 'POST' ? v : { tokens: [v] }),
    );
    expect(await api.list('p')).toEqual([v]);
    expect(await api.create('p', {} as never)).toEqual(v);
    await api.revoke('p', 't');
    expect(fetchImpl.mock.calls.map(([u, i]) => `${i?.method} ${String(u).slice(19)}`)).toEqual([
      'GET /projects/p/tokens',
      'POST /projects/p/tokens',
      'DELETE /projects/p/tokens/t',
    ]);
  });

  it('maps known error codes to messages', async () => {
    const { api } = setup(() => json({ error: 'limit_reached' }, 409));
    const err = await api.list('p').catch((e) => e);
    expect(err).toBeInstanceOf(TeamError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/50 tokens/);
  });

  it('uses the server message, then a generic one', async () => {
    const { api } = setup(() => json({ error: 'other', message: 'Nope', statusCode: 400 }, 400));
    expect((await api.list('p').catch((e) => e)).message).toBeTruthy();
    const { api: api2 } = setup(() => new Response('x', { status: 500 }));
    expect((await api2.list('p').catch((e) => e)).message).toBe('Request failed (500)');
  });

  it('reports a network failure', async () => {
    const api = new TokensApi({ baseUrl: 'https://api.test', accessToken: () => 'tok' }, (() =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch);
    const err = await api.list('p').catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Can't reach/);
  });
});

describe('tokensCore', () => {
  it('invokes agent_token_issue', async () => {
    const calls = mockCore({ agent_token_issue: { token: 'zvt_x' } });
    const out = await tokensCore.issue('p', [{ environmentId: 'e', keyVersion: 1 }]);
    expect(out).toEqual({ token: 'zvt_x' });
    expect(calls).toHaveBeenCalledWith('agent_token_issue', {
      projectId: 'p',
      environments: [{ environmentId: 'e', keyVersion: 1 }],
    });
  });
});

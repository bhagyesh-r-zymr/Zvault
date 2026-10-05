/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { describe, expect, it, vi } from 'vitest';
import { IDS, KEY, access, envAccess, org, request } from '../test/projectsFixtures.js';
import { MANAGERS_ONLY, TeamApi, TeamError, teamError } from './teamApi.js';

type Handler = (method: string, path: string, body: unknown) => Response;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(handle: Handler) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    handle(
      init?.method ?? 'GET',
      String(url).slice('https://api.test/v1'.length),
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    ),
  );
  const api = new TeamApi(
    { baseUrl: 'https://api.test', accessToken: async () => 'tok' },
    fetchImpl as unknown as typeof fetch,
  );
  const seen = () => fetchImpl.mock.calls.map(([u, i]) => `${i?.method} ${String(u).slice(19)}`);
  return { api, seen, fetchImpl };
}

describe('TeamApi', () => {
  it('reads orgs, environments and access', async () => {
    const { api, seen } = setup((_m, path) => {
      if (path === '/orgs')
        return json({ orgs: [{ id: IDS.org, name: 'Acme', role: 'owner', status: 'active' }] });
      if (path.startsWith('/orgs/')) return json(org());
      if (path.startsWith('/access/projects/')) return json(access());
      if (path.endsWith('/requests')) return json({ requests: [request()] });
      return json(envAccess(IDS.dev));
    });
    expect(await api.listOrgs()).toHaveLength(1);
    expect((await api.org(IDS.org)).name).toBe('Acme');
    expect((await api.projectAccess(IDS.project)).orgId).toBe(IDS.org);
    expect((await api.environment(IDS.dev)).environmentId).toBe(IDS.dev);
    expect(await api.listRequests(IDS.dev)).toHaveLength(1);
    expect(seen()).toContain(`GET /access/environments/${IDS.dev}/requests`);
  });

  it('writes org changes with the right bodies', async () => {
    const member = org().members[1]!;
    const { api, seen, fetchImpl } = setup((m, path) => {
      if (path.endsWith('/groups') && m === 'POST') return json(org().groups[0]);
      if (path.endsWith('/members') && m === 'POST') return json(member);
      if (m === 'POST' || path.endsWith('/join')) return json(org());
      return new Response(null, { status: 204 });
    });
    await api.createOrg('Acme', KEY);
    await api.acceptInvite(IDS.org, KEY);
    await api.invite(IDS.org, { email: 'riya@acme.dev' });
    await api.changeRole(IDS.org, IDS.riya, 'admin');
    await api.removeMember(IDS.org, IDS.riya);
    await api.createGroup(IDS.org, 'Backend');
    await api.deleteGroup(IDS.org, IDS.group);
    await api.addToGroup(IDS.org, IDS.group, IDS.riya);
    await api.removeFromGroup(IDS.org, IDS.group, IDS.riya);
    await api.removeAgent(IDS.org, IDS.bot);
    expect(seen()).toHaveLength(10);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      name: 'Acme',
      publicKey: KEY,
    });
    expect(seen()[3]).toBe(`PATCH /orgs/${IDS.org}/members/${IDS.riya}`);
  });

  it('manages grants, wraps, rotations and requests', async () => {
    const view = request({ status: 'approved' });
    const { api, seen } = setup((m, path) => {
      if (path.endsWith('/org')) return json(access());
      if (path.endsWith('/rotate')) return json(envAccess(IDS.prod, { keyVersion: 3 }));
      if (path.endsWith('/grants') && m === 'PUT') {
        return json({
          principal: { type: 'account', id: IDS.riya },
          level: 'use',
          expiresAt: null,
          grantedBy: IDS.me,
          createdAt: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path.includes('/requests/')) return json(view);
      return new Response(null, { status: 204 });
    });
    await api.linkProject(IDS.project, IDS.org);
    await api.putGrant(IDS.dev, {
      principal: { type: 'account', id: IDS.riya },
      level: 'use',
    } as never);
    await api.deleteGrant(IDS.dev, { type: 'group', id: IDS.group });
    await api.addProjectWraps(IDS.project, { wraps: [] } as never);
    await api.addEnvironmentWraps(IDS.dev, { keyVersion: 1, wraps: [] } as never);
    expect((await api.rotateEnvironment(IDS.prod, {} as never)).keyVersion).toBe(3);
    expect((await api.approveRequest(IDS.req, {} as never)).status).toBe('approved');
    expect((await api.denyRequest(IDS.req)).id).toBe(IDS.req);
    expect(seen()).toContain(`DELETE /access/environments/${IDS.dev}/grants/group/${IDS.group}`);
    expect(seen()).toContain(`POST /access/requests/${IDS.req}/deny`);
  });

  it('turns failures into TeamError', async () => {
    const { api } = setup(() => json({ error: 'x', message: 'Bad thing', statusCode: 422 }, 422));
    const err = await api.org(IDS.org).catch((e) => e);
    expect(err).toBeInstanceOf(TeamError);
    expect(err.status).toBe(422);
    const plain = setup(() => new Response('x', { status: 500 }));
    expect((await plain.api.org(IDS.org).catch((e) => e)).message).toBe('Request failed (500)');
    const offline = new TeamApi({ baseUrl: 'https://api.test', accessToken: () => 't' }, (() =>
      Promise.reject(new Error('x'))) as unknown as typeof fetch);
    expect((await offline.listOrgs().catch((e) => e)).status).toBe(0);
  });
});

describe('teamError', () => {
  it('describes errors for people', () => {
    expect(teamError(new TeamError(403, 'x'), 'f')).toBe(MANAGERS_ONLY);
    expect(teamError(new TeamError(429, 'x'), 'f')).toMatch(/Too many/);
    expect(teamError(new TeamError(400, 'Custom'), 'f')).toBe('Custom');
    expect(teamError(new Error('plain'), 'f')).toBe('plain');
    expect(teamError(42, 'fallback')).toBe('fallback');
  });
});

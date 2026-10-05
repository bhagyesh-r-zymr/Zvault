/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { describe, expect, it, vi } from 'vitest';
import {
  IDS,
  KEY,
  access,
  envAccess,
  org,
  project,
  request,
  secret,
} from '../test/projectsFixtures.js';
import type { TeamKeysCore } from './core.js';
import type { ProjectsSnapshot } from './sync.js';
import { TeamStore } from './team.js';
import { TeamError, type TeamApi } from './teamApi.js';

function makeStore(
  opts: { snapshot?: Partial<ProjectsSnapshot>; apiOver?: Record<string, unknown> } = {},
) {
  const api = {
    listOrgs: vi.fn(async () => [{ id: IDS.org, name: 'Acme', role: 'owner', status: 'active' }]),
    org: vi.fn(async () => org()),
    projectAccess: vi.fn(async () => access()),
    environment: vi.fn(async (id: string) => envAccess(id)),
    listRequests: vi.fn(async () => [request()]),
    createOrg: vi.fn(async () => org()),
    acceptInvite: vi.fn(async () => org()),
    linkProject: vi.fn(async () => access()),
    putGrant: vi.fn(async () => ({})),
    deleteGrant: vi.fn(async () => undefined),
    addProjectWraps: vi.fn(async () => undefined),
    addEnvironmentWraps: vi.fn(async () => undefined),
    rotateEnvironment: vi.fn(async () => envAccess(IDS.prod)),
    approveRequest: vi.fn(async () => request()),
    denyRequest: vi.fn(async () => request()),
    invite: vi.fn(async () => ({})),
    changeRole: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    createGroup: vi.fn(async () => ({})),
    deleteGroup: vi.fn(async () => undefined),
    addToGroup: vi.fn(async () => undefined),
    removeFromGroup: vi.fn(async () => undefined),
    removeAgent: vi.fn(async () => undefined),
    ...opts.apiOver,
  };
  const keys: TeamKeysCore = {
    wrapProjectKey: vi.fn(async () => ({ wraps: [] }) as never),
    wrapEnvironmentKey: vi.fn(async () => ({ keyVersion: 1, wraps: [] }) as never),
    rotateEnvironment: vi.fn(async () => ({}) as never),
    commitRotation: vi.fn(async () => true),
    sealRelease: vi.fn(async () => ({}) as never),
    openRelease: vi.fn(async () => [{ item: 'zv://a/b/C', value: 'secret' }]),
  };
  const snap: ProjectsSnapshot = {
    status: 'ready',
    projects: [project()],
    secrets: [secret()],
    ...opts.snapshot,
  } as ProjectsSnapshot;
  const source = { get: () => snap, pull: vi.fn(async () => undefined) };
  const store = new TeamStore(api as unknown as TeamApi, async () => KEY, keys, source);
  return { store, api, keys, source };
}

describe('TeamStore', () => {
  it('loads orgs, and reports a failure', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await store.loadOrgs();
    expect(store.get().orgsStatus).toBe('ready');
    expect(store.get().orgs).toHaveLength(1);
    expect(listener).toHaveBeenCalled();
    off();

    const bad = makeStore({
      apiOver: {
        listOrgs: vi.fn(async () => {
          throw new TeamError(500, 'down');
        }),
      },
    });
    await bad.store.loadOrgs();
    expect(bad.store.get()).toMatchObject({ orgsStatus: 'failed', orgsError: 'down' });
  });

  it('loads a project team with envs and requests', async () => {
    const { store } = makeStore();
    await store.loadProject(IDS.project);
    const team = store.get().projects[IDS.project]!;
    expect(team.status).toBe('ready');
    expect(Object.keys(team.envs)).toEqual([IDS.dev, IDS.prod]);
    expect(team.requests[IDS.dev]).toHaveLength(1);
    expect(team.org?.name).toBe('Acme');
  });

  it('tolerates a failing environment or request list', async () => {
    const { store } = makeStore({
      apiOver: {
        environment: vi.fn(async () => {
          throw new TeamError(403, 'no');
        }),
        listRequests: vi.fn(async () => {
          throw new TeamError(403, 'no');
        }),
      },
    });
    await store.loadProject(IDS.project);
    const team = store.get().projects[IDS.project]!;
    expect(team.status).toBe('ready');
    expect(team.envs[IDS.dev]).toBeUndefined();
    expect(team.requests[IDS.dev]).toBeUndefined();
  });

  it('marks a project without an org as unshared and loads orgs', async () => {
    const { store, api } = makeStore({
      apiOver: {
        projectAccess: vi.fn(async () => {
          throw new TeamError(404, 'none');
        }),
      },
    });
    await store.loadProject(IDS.project);
    expect(store.get().projects[IDS.project]!.status).toBe('unshared');
    await vi.waitFor(() => expect(api.listOrgs).toHaveBeenCalled());
  });

  it('keeps what it knew when a reload fails', async () => {
    const projectAccess = vi
      .fn()
      .mockResolvedValueOnce(access())
      .mockRejectedValueOnce(new TeamError(500, 'server down'));
    const { store } = makeStore({ apiOver: { projectAccess } });
    await store.loadProject(IDS.project);
    await store.loadProject(IDS.project);
    const team = store.get().projects[IDS.project]!;
    expect(team.status).toBe('failed');
    expect(team.error).toBe('server down');
    expect(team.access).not.toBeNull();
  });

  it('creates an org with the sharing key, accepts invites and links projects', async () => {
    const { store, api } = makeStore();
    await store.createOrg('  Acme  ');
    expect(api.createOrg).toHaveBeenCalledWith('Acme', KEY);
    await store.acceptInvite(IDS.org);
    expect(api.acceptInvite).toHaveBeenCalledWith(IDS.org, KEY);
    await store.linkProject(IDS.project, IDS.org);
    expect(api.linkProject).toHaveBeenCalledWith(IDS.project, IDS.org);
    expect(store.get().projects[IDS.project]?.status).toBe('ready');
  });

  it('grants access in each environment and hands keys to who is waiting', async () => {
    const pending = [{ accountId: IDS.riya, publicKey: KEY }];
    const { store, api, keys } = makeStore({
      apiOver: {
        projectAccess: vi.fn(async () => ({ ...access(), pendingProjectWraps: pending })),
        environment: vi.fn(async (id: string) =>
          envAccess(id, { pendingWraps: id === IDS.dev ? pending : [] }),
        ),
      },
    });
    await store.grant(IDS.project, { type: 'account', id: IDS.riya }, 'use', [IDS.dev, IDS.prod]);
    expect(api.putGrant).toHaveBeenCalledTimes(2);
    expect(keys.wrapProjectKey).toHaveBeenCalledWith(IDS.project, pending);
    expect(keys.wrapEnvironmentKey).toHaveBeenCalledWith(IDS.project, IDS.dev, 1, pending);
    expect(api.addProjectWraps).toHaveBeenCalled();
    expect(api.addEnvironmentWraps).toHaveBeenCalledWith(IDS.dev, expect.anything());
    expect(store.get().handOvers[IDS.project]).toMatchObject({
      step: null,
      error: null,
      skipped: [],
    });
  });

  it('skips environments this device cannot read and reports key errors', async () => {
    const pending = [{ accountId: IDS.riya, publicKey: KEY }];
    const locked = project();
    locked.environments[0]!.locked = true;
    const apiOver = {
      environment: vi.fn(async (id: string) => envAccess(id, { pendingWraps: pending })),
    };
    const a = makeStore({ snapshot: { projects: [locked] }, apiOver });
    await a.store.loadProject(IDS.project);
    expect(await a.store.handOverKeys(IDS.project)).toBe(false);
    expect(a.store.get().handOvers[IDS.project]!.skipped).toEqual(['Development']);
    expect(a.keys.wrapEnvironmentKey).toHaveBeenCalledTimes(1);

    const b = makeStore({ apiOver });
    await b.store.loadProject(IDS.project);
    (b.keys.wrapEnvironmentKey as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('rust boom'),
    );
    expect(await b.store.handOverKeys(IDS.project)).toBe(false);
    expect(b.store.get().handOvers[IDS.project]!.error).toBe('rust boom');
  });

  it('has nothing to hand over when nobody waits, or the project is unknown', async () => {
    const { store } = makeStore();
    expect(await store.handOverKeys(IDS.project)).toBe(false);
    await store.loadProject(IDS.project);
    expect(await store.handOverKeys(IDS.project)).toBe(true);
  });

  it('rotates an environment key and commits it', async () => {
    const { store, api, keys, source } = makeStore();
    await store.loadProject(IDS.project);
    await store.rotate(IDS.project, IDS.prod, IDS.me);
    expect(source.pull).toHaveBeenCalledTimes(2);
    expect(keys.rotateEnvironment).toHaveBeenCalledWith(
      IDS.project,
      IDS.prod,
      1,
      expect.arrayContaining([expect.objectContaining({ accountId: IDS.me })]),
      [{ secretId: IDS.secret, encryptedValue: expect.anything() }],
    );
    expect(api.rotateEnvironment).toHaveBeenCalledTimes(1);
    expect(keys.commitRotation).toHaveBeenCalledWith(IDS.project, IDS.prod);
  });

  it('retries a rotation with the holders the API names in a 422', async () => {
    const msg = `Wrap the new key for everyone with access: ${IDS.sam}`;
    const rotate = vi
      .fn()
      .mockRejectedValueOnce(new TeamError(422, msg))
      .mockResolvedValue(envAccess(IDS.prod));
    const o = org();
    o.members[2]!.publicKey = KEY as never;
    const { store, keys } = makeStore({
      apiOver: { rotateEnvironment: rotate, org: vi.fn(async () => o) },
    });
    await store.loadProject(IDS.project);
    await store.rotate(IDS.project, IDS.prod, null);
    expect(rotate).toHaveBeenCalledTimes(2);
    expect(keys.commitRotation).toHaveBeenCalled();
  });

  it('gives up on a 422 it cannot resolve, and on other errors', async () => {
    const rotate = vi.fn().mockRejectedValue(new TeamError(422, 'Someone else rotated this'));
    const { store, keys } = makeStore({ apiOver: { rotateEnvironment: rotate } });
    await store.loadProject(IDS.project);
    await expect(store.rotate(IDS.project, IDS.prod, IDS.me)).rejects.toThrow(/Someone else/);
    expect(keys.commitRotation).not.toHaveBeenCalled();
    const other = makeStore({
      apiOver: { rotateEnvironment: vi.fn().mockRejectedValue(new TeamError(500, 'x')) },
    });
    await other.store.loadProject(IDS.project);
    await expect(other.store.rotate(IDS.project, IDS.prod, IDS.me)).rejects.toThrow('x');
  });

  it('refuses to rotate before the org loads or without the key', async () => {
    const { store } = makeStore();
    await expect(store.rotate(IDS.project, IDS.prod, IDS.me)).rejects.toThrow(/still loading/);
    const locked = project();
    locked.environments[1]!.locked = true;
    const b = makeStore({ snapshot: { projects: [locked] } });
    await b.store.loadProject(IDS.project);
    await expect(b.store.rotate(IDS.project, IDS.prod, IDS.me)).rejects.toThrow(/doesn’t hold/);
  });

  it('approves a request by sealing the values to the requester', async () => {
    const { store, keys, api } = makeStore();
    await store.approve(IDS.project, request());
    expect(keys.sealRelease).toHaveBeenCalledWith(IDS.project, IDS.req, KEY, [
      expect.objectContaining({ item: 'zv://payments/production/STRIPE_KEY' }),
    ]);
    expect(api.approveRequest).toHaveBeenCalled();
  });

  it('refuses to approve a request whose values are missing, or an unknown project', async () => {
    const { store } = makeStore();
    await expect(
      store.approve(IDS.project, request({ items: ['zv://payments/production/NOPE'] })),
    ).rejects.toThrow(/No value to release/);
    const b = makeStore({ snapshot: { projects: [] } });
    await expect(b.store.approve(IDS.project, request())).rejects.toThrow(/no longer available/);
  });

  it('denies requests and revokes grants, ignoring already-gone grants', async () => {
    const { store, api } = makeStore({
      apiOver: {
        deleteGrant: vi
          .fn()
          .mockRejectedValueOnce(new TeamError(404, 'gone'))
          .mockRejectedValueOnce(new TeamError(500, 'bad')),
      },
    });
    await store.deny(IDS.project, IDS.req);
    expect(api.denyRequest).toHaveBeenCalledWith(IDS.req);
    const p = { type: 'account' as const, id: IDS.riya };
    await store.revoke(IDS.project, p, [IDS.dev]);
    await expect(store.revoke(IDS.project, p, [IDS.dev])).rejects.toThrow('bad');
  });

  it('opens a released value', async () => {
    const { store } = makeStore();
    const released = request({ status: 'approved', release: {} as never });
    expect(await store.releasedValue(released, 'zv://a/b/C')).toBe('secret');
    await expect(store.releasedValue(released, 'zv://a/b/D')).rejects.toThrow(/not released/);
    await expect(store.releasedValue(request(), 'x')).rejects.toThrow(/expired/);
  });

  it('forwards org writes and reloads the project', async () => {
    const { store, api } = makeStore();
    await store.invite(IDS.project, IDS.org, { email: 'a@b.co' });
    await store.changeRole(IDS.project, IDS.org, IDS.riya, 'admin');
    await store.removeMember(IDS.project, IDS.org, IDS.riya);
    await store.createGroup(IDS.project, IDS.org, ' Ops ');
    await store.deleteGroup(IDS.project, IDS.org, IDS.group);
    await store.addToGroup(IDS.project, IDS.org, IDS.group, IDS.riya);
    await store.removeFromGroup(IDS.project, IDS.org, IDS.group, IDS.riya);
    await store.removeAgent(IDS.project, IDS.org, IDS.bot);
    expect(api.createGroup).toHaveBeenCalledWith(IDS.org, 'Ops');
    expect(api.projectAccess).toHaveBeenCalledTimes(8);
  });
});

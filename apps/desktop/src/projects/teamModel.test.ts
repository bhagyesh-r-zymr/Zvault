import type { EnvironmentAccess, OrgDetail, ProjectAccessResponse } from '@zvault/shared';
import { describe, expect, it } from 'vitest';
import {
  buildMatrix,
  canManageEnv,
  candidates,
  levelAttr,
  levelChoices,
  pendingHandOffs,
  rotationNeeded,
  whoCanUse,
} from './teamModel.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG, PROJECT, DEV, PROD, ME, RIYA, SAM, BACKEND, BOT] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const NOW = '2026-01-01T00:00:00.000Z';
const KEY = 'A'.repeat(43) as OrgDetail['agents'][number]['publicKey'];

const org: OrgDetail = {
  id: ORG!,
  name: 'Acme',
  role: 'owner',
  members: [
    {
      accountId: ME!,
      email: 'me@acme.dev',
      role: 'owner',
      status: 'active',
      publicKey: KEY,
      groupIds: [],
    },
    {
      accountId: RIYA!,
      email: 'riya@acme.dev',
      role: 'member',
      status: 'active',
      publicKey: KEY,
      groupIds: [BACKEND!],
    },
    {
      accountId: SAM!,
      email: 'sam@acme.dev',
      role: 'member',
      status: 'invited',
      publicKey: null,
      groupIds: [],
    },
  ],
  groups: [{ id: BACKEND!, name: 'Backend', memberIds: [RIYA!] }],
  agents: [{ id: BOT!, name: 'CI bot', ownerId: ME!, publicKey: KEY, createdAt: NOW }],
};

const access: ProjectAccessResponse = {
  projectId: PROJECT!,
  orgId: ORG!,
  environments: [
    { id: DEV!, keyVersion: 1, rotationRequired: false },
    { id: PROD!, keyVersion: 2, rotationRequired: true },
  ],
  rows: [
    {
      principal: { type: 'group', id: BACKEND! },
      name: 'Backend',
      cells: [
        { environmentId: DEV!, level: 'edit', expiresAt: null },
        { environmentId: PROD!, level: 'needs_approval', expiresAt: null },
      ],
    },
    {
      principal: { type: 'account', id: RIYA! },
      name: 'riya@acme.dev',
      cells: [
        { environmentId: DEV!, level: 'use', expiresAt: '2026-10-31T23:59:59.000Z' },
        { environmentId: PROD!, level: 'none', expiresAt: null },
      ],
    },
    {
      principal: { type: 'account', id: ME! },
      name: 'me@acme.dev',
      cells: [
        { environmentId: DEV!, level: 'manage', expiresAt: null },
        { environmentId: PROD!, level: 'manage', expiresAt: null },
      ],
    },
  ],
  pendingProjectWraps: [{ accountId: RIYA!, publicKey: KEY }],
};

const grant = (
  type: 'account' | 'group' | 'agent',
  pid: string,
  level: EnvironmentAccess['myLevel'],
) => ({
  principal: { type, id: pid },
  level,
  expiresAt: null,
  grantedBy: ME!,
  createdAt: NOW,
});

const env = (envId: string, over: Partial<EnvironmentAccess>): EnvironmentAccess => ({
  environmentId: envId,
  projectId: PROJECT!,
  orgId: ORG!,
  keyVersion: 1,
  rotationRequired: false,
  myLevel: 'manage',
  grants: [],
  pendingWraps: [],
  ...over,
});

const envs = {
  [DEV!]: env(DEV!, {
    grants: [
      grant('group', BACKEND!, 'edit'),
      grant('account', RIYA!, 'use'),
      grant('account', ME!, 'manage'),
    ],
    pendingWraps: [{ accountId: RIYA!, publicKey: KEY }],
  }),
  // Riya is blocked in Production with an explicit "No access".
  [PROD!]: env(PROD!, {
    grants: [
      grant('group', BACKEND!, 'needs_approval'),
      grant('account', RIYA!, 'none'),
      grant('account', ME!, 'manage'),
    ],
  }),
};

describe('buildMatrix', () => {
  const rows = buildMatrix({ access, envs, org, meEmail: 'ME@acme.dev', day: () => 'Oct 31' });

  it('orders groups, then you, then people', () => {
    expect(rows.map((r) => r.name)).toEqual(['Backend', 'me@acme.dev', 'riya@acme.dev']);
    expect(rows[1]!.you).toBe(true);
  });

  it('tells an explicit No access from no grant', () => {
    const riya = rows.find((r) => r.principal.id === RIYA)!;
    expect(riya.cells.map((c) => [c.level, c.granted])).toEqual([
      ['use', true],
      ['none', true],
    ]);
  });

  it('describes each principal', () => {
    expect(rows[0]!.detail).toBe('Group · 1 teammate');
    expect(rows.find((r) => r.principal.id === RIYA)!.detail).toBe('Member · until Oct 31');
  });

  it('falls back to the matrix when an environment failed to load', () => {
    const partial = buildMatrix({ access, envs: { [DEV!]: envs[DEV!] }, org, meEmail: 'x@y.z' });
    const riya = partial.find((r) => r.principal.id === RIYA)!;
    expect(riya.cells[1]).toMatchObject({ level: 'none', granted: false });
  });
});

describe('access helpers', () => {
  const rows = buildMatrix({ access, envs, org, meEmail: 'me@acme.dev' });

  it('lists org principals without a row', () => {
    expect(candidates(org, rows).map((c) => c.name)).toEqual(['sam@acme.dev', 'CI bot']);
  });

  it('collects pending key hand-offs per member', () => {
    const names: Record<string, string> = { [DEV!]: 'Development', [PROD!]: 'Production' };
    expect(pendingHandOffs(access, envs, org, (e) => names[e]!)).toEqual([
      { accountId: RIYA, name: 'riya@acme.dev', waitingFor: ['project names', 'Development'] },
    ]);
  });

  it('flags environments that need a rotation', () => {
    expect(rotationNeeded(access)).toEqual([PROD]);
  });

  it('lists who can use an environment, strongest first, without blocked grants', () => {
    expect(whoCanUse(rows, PROD!).map((u) => [u.name, u.level])).toEqual([
      ['me@acme.dev', 'manage'],
      ['Backend', 'needs_approval'],
    ]);
  });

  it('offers only the levels the API accepts', () => {
    expect(levelChoices('agent')).toEqual(['needs_approval', 'none']);
    expect(levelChoices('group')).not.toContain('none');
    expect(levelAttr('needs_approval')).toBe('approval');
  });

  it('lets org admins or environment managers change grants', () => {
    expect(canManageEnv({ ...org, role: 'member' }, env(DEV!, { myLevel: 'edit' }))).toBe(false);
    expect(canManageEnv({ ...org, role: 'member' }, env(DEV!, { myLevel: 'manage' }))).toBe(true);
    expect(canManageEnv({ ...org, role: 'admin' }, undefined)).toBe(true);
  });
});

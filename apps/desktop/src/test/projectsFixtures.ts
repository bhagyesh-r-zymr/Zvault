import type {
  AccessRequestView,
  EncryptedBlob,
  EnvironmentAccess,
  OrgDetail,
  ProjectAccessResponse,
} from '@zvault/shared';
import type { Environment, Project, ProjectSecret } from '../projects/model.js';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const NOW = '2026-01-01T00:00:00.000Z';
export const KEY = 'A'.repeat(43) as OrgDetail['agents'][number]['publicKey'];

export const IDS = {
  org: uid(1),
  project: uid(2),
  dev: uid(3),
  prod: uid(4),
  me: uid(5),
  riya: uid(6),
  sam: uid(7),
  group: uid(8),
  bot: uid(9),
  secret: uid(10),
  folder: uid(11),
  req: uid(12),
};

export const blob = (kid: string, value = 'x'): EncryptedBlob =>
  ({
    v: 1,
    alg: 'xchacha20poly1305',
    kid,
    nonce: 'A'.repeat(32),
    ct: btoa(value),
  }) as EncryptedBlob;

export function env(over: Partial<Environment> & { id: string; name: string }): Environment {
  return {
    revision: 1,
    slug: over.name.toLowerCase(),
    short: over.name.slice(0, 4),
    kind: 'development',
    color: 'var(--secure)',
    position: 0,
    inheritsFrom: null,
    locked: false,
    sync: [],
    ...over,
  };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: IDS.project,
    slug: 'payments',
    name: 'Payments',
    owner: true,
    tile: { bg: 'var(--tile-navy)', fg: 'var(--tile-ink)' },
    environments: [
      env({ id: IDS.dev, name: 'Development', slug: 'development', short: 'Dev' }),
      env({
        id: IDS.prod,
        name: 'Production',
        slug: 'production',
        short: 'Prod',
        kind: 'production',
        position: 1,
        color: 'var(--danger)',
      }),
    ],
    folders: [{ id: IDS.folder, revision: 1, name: 'Billing', slug: 'billing' }],
    ...over,
  };
}

export function secret(over: Partial<ProjectSecret> = {}): ProjectSecret {
  return {
    id: IDS.secret,
    projectId: IDS.project,
    revision: 1,
    name: 'Stripe key',
    key: 'STRIPE_KEY',
    folder: null,
    tags: [],
    values: { [IDS.dev]: blob(IDS.dev, 'dev-value'), [IDS.prod]: blob(IDS.prod, 'prod-value') },
    ...over,
  };
}

export const org = (): OrgDetail => ({
  id: IDS.org,
  name: 'Acme',
  role: 'owner',
  members: [
    {
      accountId: IDS.me,
      email: 'me@acme.dev',
      role: 'owner',
      status: 'active',
      publicKey: KEY,
      groupIds: [],
    },
    {
      accountId: IDS.riya,
      email: 'riya@acme.dev',
      role: 'member',
      status: 'active',
      publicKey: KEY,
      groupIds: [IDS.group],
    },
    {
      accountId: IDS.sam,
      email: 'sam@acme.dev',
      role: 'member',
      status: 'invited',
      publicKey: null,
      groupIds: [],
    },
  ],
  groups: [{ id: IDS.group, name: 'Backend', memberIds: [IDS.riya] }],
  agents: [{ id: IDS.bot, name: 'CI bot', ownerId: IDS.me, publicKey: KEY, createdAt: NOW }],
});

export const access = (): ProjectAccessResponse => ({
  projectId: IDS.project,
  orgId: IDS.org,
  environments: [
    { id: IDS.dev, keyVersion: 1, rotationRequired: false },
    { id: IDS.prod, keyVersion: 2, rotationRequired: true },
  ],
  rows: [
    {
      principal: { type: 'account', id: IDS.me },
      name: 'me@acme.dev',
      cells: [
        { environmentId: IDS.dev, level: 'manage', expiresAt: null },
        { environmentId: IDS.prod, level: 'manage', expiresAt: null },
      ],
    },
    {
      principal: { type: 'account', id: IDS.riya },
      name: 'riya@acme.dev',
      cells: [
        { environmentId: IDS.dev, level: 'use', expiresAt: null },
        { environmentId: IDS.prod, level: 'none', expiresAt: null },
      ],
    },
  ],
  pendingProjectWraps: [],
});

export const envAccess = (
  environmentId: string,
  over: Partial<EnvironmentAccess> = {},
): EnvironmentAccess => ({
  environmentId,
  projectId: IDS.project,
  orgId: IDS.org,
  keyVersion: 1,
  rotationRequired: false,
  myLevel: 'manage',
  grants: [
    {
      principal: { type: 'account', id: IDS.me },
      level: 'manage',
      expiresAt: null,
      grantedBy: IDS.me,
      createdAt: NOW,
    },
    {
      principal: { type: 'account', id: IDS.riya },
      level: 'use',
      expiresAt: null,
      grantedBy: IDS.me,
      createdAt: NOW,
    },
  ],
  pendingWraps: [],
  ...over,
});

export const request = (over: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id: IDS.req,
  environmentId: IDS.prod,
  requester: { type: 'account', id: IDS.riya },
  requesterName: 'riya@acme.dev',
  requesterPublicKey: KEY,
  items: ['zv://payments/production/STRIPE_KEY'],
  reason: 'deploy',
  status: 'pending',
  createdAt: NOW,
  expiresAt: NOW,
  decidedBy: null,
  release: null,
  ...over,
});

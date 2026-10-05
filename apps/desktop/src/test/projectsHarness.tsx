/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  ActivityContext,
  ProjectsContext,
  SecretSyncContext,
  TeamContext,
} from '../projects/context.js';
import type { ActivityReporter } from '../projects/activity.js';
import type { SecretSyncer, SecretSyncSnapshot } from '../projects/secretSync.js';
import type { ProjectsSnapshot, ProjectsSync } from '../projects/sync.js';
import type { ProjectTeam, TeamSnapshot, TeamStore } from '../projects/team.js';
import { project, secret } from './projectsFixtures.js';

const resolved = () => vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);

/** A stand-in for `ProjectsSync` whose writes are spies that resolve. */
export function fakeSync(
  snapshot: Partial<ProjectsSnapshot> = {},
  methods: Record<string, unknown> = {},
) {
  const snap: ProjectsSnapshot = {
    status: 'ready',
    error: null,
    unreadable: 0,
    projects: [project()],
    secrets: [secret()],
    ...snapshot,
  };
  const sync = {
    get: () => snap,
    subscribe: () => () => undefined,
    load: resolved(),
    pull: resolved(),
    updateProject: resolved(),
    deleteProject: resolved(),
    createProject: vi.fn(async () => 'new-project-id'),
    createEnvironment: vi.fn(async () => 'new-env-id'),
    updateEnvironment: resolved(),
    setSyncTargets: resolved(),
    deleteEnvironment: resolved(),
    secretsOnlyIn: vi.fn((): string[] => []),
    createFolder: vi.fn(async () => 'new-folder-id'),
    deleteFolder: resolved(),
    removeValue: resolved(),
    createSecret: vi.fn(async () => 'new-secret-id'),
    putSealedValue: resolved(),
    deleteSecret: resolved(),
    secretHistory: vi.fn(async (): Promise<unknown[]> => []),
    openHistoricValue: vi.fn(async () => 'oldvalue'),
    restoreSecretVersion: resolved(),
    trash: vi.fn(async (): Promise<unknown[]> => []),
    restoreFromTrash: resolved(),
    purge: resolved(),
    openValue: vi.fn(async () => 'plainvalue'),
    ...methods,
  };
  return sync as unknown as ProjectsSync & {
    [K in keyof typeof sync]: (typeof sync)[K];
  };
}

/** A stand-in for `TeamStore` serving the given per-project state. */
export function fakeTeam(
  projects: Record<string, ProjectTeam | undefined> = {},
  snapshot: Partial<TeamSnapshot> = {},
  methods: Record<string, unknown> = {},
) {
  const snap: TeamSnapshot = {
    orgsStatus: 'ready',
    orgsError: null,
    orgs: [],
    projects,
    handOvers: {},
    ...snapshot,
  };
  const store = {
    get: () => snap,
    subscribe: () => () => undefined,
    loadOrgs: resolved(),
    loadProject: resolved(),
    createOrg: resolved(),
    acceptInvite: resolved(),
    linkProject: resolved(),
    grant: resolved(),
    handOverKeys: vi.fn(async () => true),
    rotate: resolved(),
    approve: resolved(),
    deny: resolved(),
    releasedValue: vi.fn(async () => 'released'),
    revoke: resolved(),
    invite: resolved(),
    changeRole: resolved(),
    removeMember: resolved(),
    createGroup: resolved(),
    deleteGroup: resolved(),
    addToGroup: resolved(),
    removeFromGroup: resolved(),
    removeAgent: resolved(),
    ...methods,
  };
  return store as unknown as TeamStore & { [K in keyof typeof store]: (typeof store)[K] };
}

export interface Providers {
  sync?: ProjectsSync;
  team?: TeamStore;
  email?: string;
  activity?: ActivityReporter | null;
  secretSync?: SecretSyncer;
}

/** Renders `ui` inside the project contexts the app shell normally provides. */
export function renderWithProjects(ui: ReactElement, p: Providers = {}): RenderResult {
  const sync = p.sync ?? fakeSync();
  const team = p.team ?? fakeTeam();
  const secretSync = p.secretSync ?? fakeSecretSyncer();
  return render(
    <ProjectsContext.Provider value={sync}>
      <TeamContext.Provider value={{ store: team, email: p.email ?? 'me@acme.dev' }}>
        <ActivityContext.Provider value={p.activity ?? null}>
          <SecretSyncContext.Provider value={secretSync}>{ui}</SecretSyncContext.Provider>
        </ActivityContext.Provider>
      </TeamContext.Provider>
    </ProjectsContext.Provider>,
  );
}

export function fakeActivity() {
  return {
    viewed: vi.fn(),
    copied: vi.fn(),
    shared: vi.fn(),
  } as unknown as ActivityReporter &
    Record<'viewed' | 'copied' | 'shared', ReturnType<typeof vi.fn>>;
}

export function fakeSecretSyncer(
  snapshot: Partial<SecretSyncSnapshot> = {},
  methods: Record<string, unknown> = {},
) {
  const snap = { connections: null, status: {}, ...snapshot } as SecretSyncSnapshot;
  const syncer = {
    get: () => snap,
    subscribe: () => () => undefined,
    connections: vi.fn(async () => snap.connections),
    connect: vi.fn(async () => 'octocat'),
    disconnect: resolved(),
    syncTarget: resolved(),
    syncEnvironment: resolved(),
    ...methods,
  };
  return syncer as unknown as SecretSyncer & { [K in keyof typeof syncer]: (typeof syncer)[K] };
}

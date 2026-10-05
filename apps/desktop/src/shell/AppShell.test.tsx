/* eslint-disable @typescript-eslint/require-await -- test doubles */
import { emit } from '@tauri-apps/api/event';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrgSummary } from '@zvault/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Session } from '../auth.js';
import type { Project, ProjectSecret } from '../projects/model.js';
import { settleOnUnmount } from '../test/settle.js';
import { mockCore } from '../test/tauri.js';
import { AppShell } from './AppShell.js';

const h = vi.hoisted(() => {
  const fakeSync = {
    snapshot: { status: 'ready', error: null, unreadable: 0, projects: [], secrets: [] } as {
      status: string;
      error: string | null;
      unreadable: number;
      projects: unknown[];
      secrets: unknown[];
    },
    listeners: new Set<() => void>(),
    load: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    get() {
      return fakeSync.snapshot;
    },
    subscribe(l: () => void) {
      fakeSync.listeners.add(l);
      return () => fakeSync.listeners.delete(l);
    },
  };
  const fakeTeam = {
    snapshot: { orgs: [] as unknown[] },
    listeners: new Set<() => void>(),
    loadOrgs: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    acceptInvite: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    get() {
      return fakeTeam.snapshot;
    },
    subscribe(l: () => void) {
      fakeTeam.listeners.add(l);
      return () => fakeTeam.listeners.delete(l);
    },
  };
  return {
    fakeSync,
    fakeTeam,
    reporter: {
      agent: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
      flush: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    },
    stopZv: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    serveZv: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
    syncerStop: undefined as unknown as Mock<(...a: unknown[]) => unknown>,
  };
});

vi.mock('../projects/sync.js', () => ({
  ProjectsSync: function () {
    return h.fakeSync;
  },
}));
vi.mock('../projects/team.js', () => ({
  TeamStore: function () {
    return h.fakeTeam;
  },
}));
vi.mock('../projects/secretSync.js', () => ({
  SecretSyncer: function () {
    return { start: () => h.syncerStop };
  },
}));
vi.mock('../agents/bridge.js', () => ({
  serveZv: (...args: unknown[]) => h.serveZv(...args),
}));
vi.mock('../projects/activity.js', async (orig) => ({
  ...(await orig<typeof import('../projects/activity.js')>()),
  ActivityReporter: function () {
    return h.reporter;
  },
}));
vi.mock('../sharing/core.js', () => ({ sharingCore: { identity: vi.fn() } }));

vi.mock('../vault/VaultScreen.js', () => ({
  FOCUS_SEARCH_EVENT: 'zv-focus-search',
  VaultScreen: () => <div>vault-screen</div>,
}));
vi.mock('../projects/ProjectsView.js', () => ({
  ProjectTile: () => <span>tile</span>,
  ProjectsView: (p: {
    projectId: string;
    envId: string;
    secretId?: string;
    onEnvChange: (e: string) => void;
    onOpenProject: (p: string, e: string) => void;
    onOpenAccess: () => void;
  }) => (
    <div>
      projects-view {p.projectId} {p.envId} {p.secretId ?? '-'}
      <button type="button" onClick={() => p.onEnvChange('e2')}>
        change-env
      </button>
      <button type="button" onClick={() => p.onOpenProject('p2', 'x1')}>
        open-other
      </button>
      <button type="button" onClick={p.onOpenAccess}>
        open-access
      </button>
    </div>
  ),
}));
vi.mock('../projects/EnvironmentsView.js', () => ({
  EnvironmentsView: (p: { projectId: string; onOpenEnvironment: (e: string) => void }) => (
    <div>
      environments-view {p.projectId}
      <button type="button" onClick={() => p.onOpenEnvironment('e1')}>
        open-env
      </button>
    </div>
  ),
}));
vi.mock('../projects/ProjectAccess.js', () => ({
  ProjectAccess: (p: { projectId: string }) => <div>access-view {p.projectId}</div>,
}));
vi.mock('../projects/ProjectActivity.js', () => ({
  ProjectActivity: (p: {
    projectId: string;
    email: string;
    onOpenSecret: (s: string, e: string) => void;
  }) => (
    <div>
      activity-view {p.projectId} {p.email}
      <button type="button" onClick={() => p.onOpenSecret('s1', 'e1')}>
        open-secret
      </button>
    </div>
  ),
}));
vi.mock('../projects/NewProjectSheet.js', () => ({
  NewProjectSheet: (p: { onClose: () => void; onCreated: (id: string) => void }) => (
    <div>
      new-project-sheet
      <button type="button" onClick={p.onClose}>
        cancel-new
      </button>
      <button type="button" onClick={() => p.onCreated('p1')}>
        created-p1
      </button>
      <button type="button" onClick={() => p.onCreated('p3')}>
        created-p3
      </button>
    </div>
  ),
}));
vi.mock('../agents/AgentsView.js', () => ({ AgentsView: () => <div>agents-view</div> }));
vi.mock('../agents/AgentPrompts.js', () => ({ AgentPrompts: () => <div>agent-prompts</div> }));
vi.mock('../sharing/SharingCenter.js', () => ({ SharingCenter: () => <div>sharing-view</div> }));
vi.mock('../trash/TrashView.js', () => ({ TrashView: () => <div>trash-view</div> }));
vi.mock('../generator/Generator.js', () => ({ Generator: () => <div>generator</div> }));
vi.mock('../generator/StrengthChecker.js', () => ({
  StrengthChecker: () => <div>strength-checker</div>,
}));
vi.mock('./SettingsView.js', () => ({
  SettingsView: (p: { section: string; onSection: (s: string) => void; onSignOut: () => void }) => (
    <div>
      settings-view {p.section}
      <button type="button" onClick={() => p.onSection('devices')}>
        goto-devices
      </button>
      <button type="button" onClick={p.onSignOut}>
        settings-signout
      </button>
    </div>
  ),
}));

settleOnUnmount();

const session: Session = {
  email: 'ada@example.com',
  token: 'tok',
  expiresAt: '2030-01-01T00:00:00Z',
};

const project = (id: string, name: string, envs: string[]): Project => ({
  id,
  slug: name.toLowerCase(),
  name,
  owner: true,
  tile: { bg: 'a', fg: 'b' },
  environments: envs.map((e) => ({ id: e, slug: e, name: e }) as never),
  folders: [],
});

function setProjects(projects: Project[], status = 'ready', secrets: ProjectSecret[] = []) {
  h.fakeSync.snapshot = { status, error: null, unreadable: 0, projects, secrets };
  act(() => h.fakeSync.listeners.forEach((l) => l()));
}

let calls: ReturnType<typeof mockCore>;

function mount(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const p = {
    session,
    lockStatus: null,
    onLockChanged: vi.fn(),
    remembered: null,
    onForgetSecretKey: vi.fn(() => Promise.resolve()),
    onSignOut: vi.fn(),
    ...props,
  };
  render(<AppShell {...p} />);
  return p;
}

beforeEach(() => {
  h.fakeSync.snapshot = { status: 'ready', error: null, unreadable: 0, projects: [], secrets: [] };
  h.fakeSync.listeners.clear();
  h.fakeSync.load = vi.fn(() => Promise.resolve());
  h.fakeTeam.snapshot = { orgs: [] };
  h.fakeTeam.listeners.clear();
  h.fakeTeam.loadOrgs = vi.fn(() => Promise.resolve());
  h.fakeTeam.acceptInvite = vi.fn(() => Promise.resolve());
  h.reporter.agent = vi.fn();
  h.reporter.flush = vi.fn(() => Promise.resolve());
  h.stopZv = vi.fn();
  h.serveZv = vi.fn(() => h.stopZv);
  h.syncerStop = vi.fn();
  calls = mockCore({ lock_vault: undefined, agent_activity: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppShell startup', () => {
  it('shows the account, the personal vault and loads projects, orgs and the zv bridge', () => {
    mount();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('vault-screen')).toBeInTheDocument();
    expect(screen.getByText('agent-prompts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Personal/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(h.fakeSync.load).toHaveBeenCalled();
    expect(h.fakeTeam.loadOrgs).toHaveBeenCalled();
    expect(h.serveZv).toHaveBeenCalled();
  });

  it('stops background work when unmounted', async () => {
    const { unmount } = render(
      <AppShell
        session={session}
        lockStatus={null}
        onLockChanged={() => undefined}
        remembered={null}
        onForgetSecretKey={() => Promise.resolve()}
        onSignOut={() => undefined}
      />,
    );
    unmount();
    expect(h.stopZv).toHaveBeenCalled();
    expect(h.syncerStop).toHaveBeenCalled();
    expect(h.reporter.flush).toHaveBeenCalled();
  });
});

describe('AppShell navigation', () => {
  it('moves between the main sections', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Agents' }));
    expect(screen.getByText('agents-view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sharing' }));
    expect(screen.getByText('sharing-view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trash' }));
    expect(screen.getByText('trash-view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Password generator' }));
    expect(screen.getByText('generator')).toBeInTheDocument();
    expect(screen.getByText('strength-checker')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('settings-view security')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'goto-devices' }));
    expect(screen.getByText('settings-view devices')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Personal' }));
    expect(screen.getByText('vault-screen')).toBeInTheDocument();
  });

  it('passes sign out through to settings', async () => {
    const user = userEvent.setup();
    const p = mount();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'settings-signout' }));
    expect(p.onSignOut).toHaveBeenCalled();
  });

  it('locks from the sidebar button', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /Lock now/ }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('lock_vault', {}));
  });

  it('search button returns to the vault and asks it to focus search', async () => {
    const user = userEvent.setup();
    const focus = vi.fn();
    window.addEventListener('zv-focus-search', focus);
    mount();
    await user.click(screen.getByRole('button', { name: 'Agents' }));
    await user.click(screen.getByRole('button', { name: /Search/ }));
    expect(screen.getByText('vault-screen')).toBeInTheDocument();
    await waitFor(() => expect(focus).toHaveBeenCalled());
    window.removeEventListener('zv-focus-search', focus);
  });
});

describe('AppShell keyboard shortcuts', () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, metaKey: true, bubbles: true, ...init }),
      );
    });

  it('opens settings with the mod key and a comma', async () => {
    mount();
    press(',');
    expect(await screen.findByText('settings-view security')).toBeInTheDocument();
  });

  it('jumps to the vault search with mod-K', async () => {
    const user = userEvent.setup();
    const focus = vi.fn();
    window.addEventListener('zv-focus-search', focus);
    mount();
    await user.click(screen.getByRole('button', { name: 'Agents' }));
    press('K');
    expect(await screen.findByText('vault-screen')).toBeInTheDocument();
    await waitFor(() => expect(focus).toHaveBeenCalled());
    window.removeEventListener('zv-focus-search', focus);
  });

  it('locks with mod-L', async () => {
    mount();
    press('l');
    await waitFor(() => expect(calls).toHaveBeenCalledWith('lock_vault', {}));
  });

  it('ignores other keys, shifted and bare shortcuts', async () => {
    mount();
    press('x');
    press(',', { shiftKey: true });
    press(',', { altKey: true });
    press(',', { ctrlKey: false, metaKey: false });
    expect(screen.getByText('vault-screen')).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalledWith('lock_vault', {});
  });
});

describe('AppShell projects', () => {
  it('offers to create the first project and shows the sheet', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /Create your first project/ }));
    expect(screen.getByText('new-project-sheet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'cancel-new' }));
    expect(screen.queryByText('new-project-sheet')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByText('new-project-sheet')).toBeInTheDocument();
  });

  it('offers a retry when projects fail to load', async () => {
    const user = userEvent.setup();
    mount();
    setProjects([], 'failed');
    h.fakeSync.load.mockClear();
    await user.click(screen.getByRole('button', { name: /Couldn.t load/ }));
    expect(h.fakeSync.load).toHaveBeenCalled();
  });

  it('starts with the first project open and navigates its pages', async () => {
    const user = userEvent.setup();
    mount();
    setProjects([project('p1', 'Web', ['e1', 'e2']), project('p2', 'API', [])]);
    expect(screen.getByRole('button', { name: 'Secrets' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Secrets' }));
    expect(screen.getByText('projects-view p1 e1 -')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secrets' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'change-env' }));
    expect(screen.getByText('projects-view p1 e2 -')).toBeInTheDocument();
    // Staying in the project keeps the open environment.
    await user.click(screen.getByRole('button', { name: 'Secrets' }));
    expect(screen.getByText('projects-view p1 e2 -')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'open-other' }));
    expect(screen.getByText('projects-view p2 x1 -')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Environments' }));
    expect(screen.getByText('environments-view p1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'open-env' }));
    expect(screen.getByText('projects-view p1 e1 -')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'open-access' }));
    expect(screen.getByText('access-view p1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Access' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText('activity-view p1 ada@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'open-secret' }));
    expect(screen.getByText('projects-view p1 e1 s1')).toBeInTheDocument();
  });

  it('folds and unfolds projects', async () => {
    const user = userEvent.setup();
    mount();
    setProjects([project('p1', 'Web', ['e1']), project('p2', 'API', ['x1'])]);
    const web = screen.getByRole('button', { name: /Web/ });
    expect(web).toHaveAttribute('aria-expanded', 'true');
    await user.click(web);
    expect(web).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Secrets' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /API/ }));
    expect(screen.getByRole('button', { name: 'Secrets' })).toBeInTheDocument();
    await user.click(web);
    expect(screen.getAllByRole('button', { name: 'Secrets' })).toHaveLength(2);
  });

  it('goes to adding an environment for a project without any', async () => {
    const user = userEvent.setup();
    mount();
    setProjects([project('p1', 'Web', [])]);
    await user.click(screen.getByRole('button', { name: 'Secrets' }));
    expect(screen.getByText('environments-view p1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add environment' })).toBeInTheDocument();
  });

  it('opens a created project on its first environment, or environments when empty', async () => {
    const user = userEvent.setup();
    mount();
    setProjects([project('p1', 'Web', ['e1'])]);
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'created-p1' }));
    expect(screen.getByText('projects-view p1 e1 -')).toBeInTheDocument();
    expect(screen.queryByText('new-project-sheet')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'created-p3' }));
    expect(screen.getByText('environments-view p3')).toBeInTheDocument();
  });
});

describe('AppShell team invites', () => {
  it('shows pending invites and reloads projects after accepting', async () => {
    const user = userEvent.setup();
    const org: OrgSummary = { id: 'o1', name: 'Acme', role: 'member', status: 'invited' };
    h.fakeTeam.snapshot = { orgs: [org] };
    mount();
    h.fakeSync.load.mockClear();
    await user.click(screen.getByRole('button', { name: /Team invite from Acme/ }));
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(h.fakeSync.load).toHaveBeenCalled());
    expect(h.fakeTeam.acceptInvite).toHaveBeenCalledWith('o1');
  });
});

describe('AppShell agent activity reporting', () => {
  it('reports new agent use of project secrets once', async () => {
    const web = project('p1', 'Web', ['dev']);
    const secret = {
      id: 's1',
      projectId: 'p1',
      key: 'API_KEY',
      folder: null,
      values: {},
    } as unknown as ProjectSecret;
    (web.environments[0] as { slug: string }).slug = 'dev';
    const at = Math.floor(Date.now() / 1000) + 5;
    const entry = {
      at,
      agentId: 'a1',
      agentName: 'Claude Code',
      outcome: 'allowed',
      refs: ['zv://web/dev/API_KEY'],
      purpose: { kind: 'read', command: ['zv', 'read'], cwd: null },
      reason: null,
      verifiedBy: null,
      peerPid: null,
    };
    calls = mockCore({ lock_vault: undefined, agent_activity: [entry] });
    mount();
    setProjects([web], 'ready', [secret]);
    await new Promise((r) => setTimeout(r, 0));
    await emit('agent://activity', null);
    await waitFor(() => expect(h.reporter.agent).toHaveBeenCalledWith('p1', expect.anything()));
    const n = h.reporter.agent.mock.calls.length;
    await emit('agent://activity', null);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reporter.agent.mock.calls.length).toBe(n);
  });

  it('ignores activity that predates the window or fails to load', async () => {
    calls = mockCore({
      lock_vault: undefined,
      agent_activity: () => Promise.reject(new Error('x')),
    });
    mount();
    await new Promise((r) => setTimeout(r, 0));
    await emit('agent://activity', null);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reporter.agent).not.toHaveBeenCalled();
  });
});

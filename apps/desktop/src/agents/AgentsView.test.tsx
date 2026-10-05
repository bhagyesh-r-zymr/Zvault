/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- test doubles */
import { emit } from '@tauri-apps/api/event';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { settleOnUnmount } from '../test/settle.js';
import { mockCore } from '../test/tauri.js';
import type { ActivityEntry, Agent } from './api.js';
import { AgentsView } from './AgentsView.js';

settleOnUnmount();

const now = () => Math.floor(Date.now() / 1000);

const claude = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'Claude Code',
  kind: 'agent',
  createdAt: now() - 7200,
  lastUsedAt: now() - 300,
  paused: false,
  approval: 'askEveryTime',
  scopes: ['zv://web/dev/*'],
  ...over,
});
const browser = (over: Partial<Agent> = {}): Agent => ({
  id: 'browser-1',
  name: 'Chrome',
  kind: 'browser',
  createdAt: now() - 100_000,
  lastUsedAt: null,
  paused: false,
  approval: 'whileUnlocked',
  scopes: [],
  ...over,
});

const act = (over: Partial<ActivityEntry>): ActivityEntry => ({
  at: now() - 10,
  agentId: 'agent-1',
  agentName: 'Claude Code',
  outcome: 'allowed',
  refs: [],
  purpose: null,
  reason: null,
  verifiedBy: null,
  peerPid: null,
  ...over,
});

function setup(
  agents: Agent[],
  activity: ActivityEntry[] = [],
  extra: Record<string, unknown> = {},
) {
  let list = agents;
  const calls = mockCore({
    agent_list: () => list,
    agent_activity: activity,
    agent_update: (a: Record<string, unknown>) => {
      list = list.map((x) => (x.id === a.agentId ? { ...x, ...a, agentId: undefined } : x));
      return list[0];
    },
    agent_unpair: (a: Record<string, unknown>) => {
      list = list.filter((x) => x.id !== a.agentId);
    },
    cli_status: { bundled: true, installedAt: null, onPath: false, command: 'cmd' },
    browser_extension_status: { bundled: true, browsers: ['Chrome'], extensionId: 'x' },
    ...extra,
  });
  render(<AgentsView />);
  return calls;
}

describe('AgentsView', () => {
  it('shows setup help when nothing is paired', async () => {
    const user = userEvent.setup();
    setup([]);
    expect(await screen.findByText('Connect an agent')).toBeInTheDocument();
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument();
    expect(screen.getByText('Fill logins in your browser')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Pair an agent/ }));
    expect(screen.getByText('Pairing starts from the terminal the agent uses')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(
      screen.queryByText('Pairing starts from the terminal the agent uses'),
    ).not.toBeInTheDocument();
  });

  it('opens the install and browser sheets', async () => {
    const user = userEvent.setup();
    setup([]);
    await screen.findByText('Connect an agent');
    await user.click(screen.getAllByRole('button', { name: /Install CLI/ })[0]!);
    expect(screen.getByText('Then paste the instructions into Claude Code')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(
      screen.queryByText('Then paste the instructions into Claude Code'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add the browser extension' }));
    expect(screen.getByText(/Fill logins and 2FA codes in Chrome/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('lists agents and shows the first agent’s details and activity', async () => {
    setup(
      [claude(), browser({ paused: true })],
      [
        act({ outcome: 'paired' }),
        act({ outcome: 'unpaired' }),
        act({
          outcome: 'allowed',
          refs: ['zv://a/b/KEY'],
          purpose: { kind: 'run', command: ['npm', 'ci'], cwd: null },
        }),
        act({ outcome: 'approved', refs: ['x', 'y'] }),
        act({ outcome: 'allowed', refs: [], purpose: { kind: 'list', command: [], cwd: null } }),
        act({
          outcome: 'allowed',
          purpose: { kind: 'change', command: [], cwd: null, detail: 'Created project' },
        }),
        act({ outcome: 'denied', refs: ['zv://a/b/KEY'], reason: 'denied' }),
        act({ outcome: 'denied', refs: [] }),
        act({
          outcome: 'denied',
          purpose: { kind: 'change', command: [], cwd: null, detail: 'Delete it' },
          reason: 'locked',
        }),
        act({ outcome: 'allowed', at: now() - 90_000 }),
      ],
    );
    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByText('1 scope · asks each time')).toBeInTheDocument();
    expect(screen.getAllByText('Paused').length).toBe(2);
    expect(screen.getByText('zv://web/dev/*')).toBeInTheDocument();
    expect(await screen.findByText('Paired')).toBeInTheDocument();
    expect(screen.getByText('Unpaired')).toBeInTheDocument();
    expect(screen.getByText('Used zv://a/b/KEY for npm ci')).toBeInTheDocument();
    expect(screen.getByText('Used 2 secrets')).toBeInTheDocument();
    expect(screen.getByText('Allowed list')).toBeInTheDocument();
    expect(screen.getByText('Created project')).toBeInTheDocument();
    expect(screen.getByText('Denied zv://a/b/KEY (denied)')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getByText('Denied: Delete it (locked)')).toBeInTheDocument();
    expect(screen.getAllByText('5 min ago').length).toBeGreaterThan(0);
  });

  it('changes the approval policy, pauses, and manages scopes', async () => {
    const user = userEvent.setup();
    const calls = setup([claude({ scopes: [] })]);
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(screen.getByText(/can't read anything/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Allow for a session/ }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_update', {
        agentId: 'agent-1',
        approval: 'session15m',
      }),
    );

    await user.click(screen.getByRole('button', { name: /Pause/ }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_update', { agentId: 'agent-1', paused: true }),
    );
    expect(await screen.findByRole('button', { name: /Resume/ })).toBeInTheDocument();

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Add a scope'), '  zv://pay/prod/*  {Enter}');
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_update', {
        agentId: 'agent-1',
        scopes: ['zv://pay/prod/*'],
      }),
    );
    expect(await screen.findByText('zv://pay/prod/*')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Add a scope')).toHaveValue(''));

    await user.click(screen.getByRole('button', { name: 'Remove zv://pay/prod/*' }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_update', { agentId: 'agent-1', scopes: [] }),
    );
  });

  it('selects another agent and shows browser-specific details', async () => {
    const user = userEvent.setup();
    setup([claude(), browser()]);
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(screen.getByText('Fills logins')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Chrome/ }));
    expect(await screen.findByRole('heading', { name: 'Chrome' })).toBeInTheDocument();
    expect(screen.getByText('When it fills a login')).toBeInTheDocument();
    expect(screen.getByText(/cannot read project secrets/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a scope')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });

  it('unpairs an agent', async () => {
    const user = userEvent.setup();
    const calls = setup([claude()]);
    await user.click(await screen.findByRole('button', { name: 'Unpair Claude Code' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('agent_unpair', { agentId: 'agent-1' }));
    expect(await screen.findByText('Connect an agent')).toBeInTheDocument();
  });

  it('shows errors from loading, updating and unpairing', async () => {
    const user = userEvent.setup();
    setup([claude()], [], {
      agent_update: () => Promise.reject(new Error('update failed')),
      agent_unpair: () => Promise.reject('unpair failed'),
    });
    await user.click(await screen.findByRole('button', { name: /Pause/ }));
    expect(await screen.findByText('update failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unpair Claude Code' }));
    expect(await screen.findByText(/unpair failed/)).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    setup([], [], { agent_list: () => Promise.reject(new Error('core offline')) });
    expect(await screen.findByText('core offline')).toBeInTheDocument();
  });

  it('reloads when agent activity arrives', async () => {
    const calls = setup([claude()]);
    await screen.findByRole('heading', { name: 'Claude Code' });
    const before = calls.mock.calls.filter(([c]) => c === 'agent_list').length;
    await emit('agent://activity', null);
    await waitFor(() =>
      expect(calls.mock.calls.filter(([c]) => c === 'agent_list').length).toBeGreaterThan(before),
    );
    expect(within(screen.getByLabelText('Agents')).getByText('Claude Code')).toBeInTheDocument();
  });

  it('formats stale timestamps as dates', async () => {
    setup([claude({ lastUsedAt: now() - 3 * 86400, createdAt: now() - 3 * 3600 })]);
    expect(await screen.findByText(/paired 3 h ago/)).toBeInTheDocument();
  });

  it('handles a failing activity request', async () => {
    setup([claude()], [], { agent_activity: () => Promise.reject(new Error('x')) });
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
  });

  it('shows "just now" and initials for a single-word name', async () => {
    setup([claude({ name: 'cursor', lastUsedAt: now() - 5 })]);
    expect(await screen.findByText('just now')).toBeInTheDocument();
    expect(screen.getAllByText('CU').length).toBeGreaterThan(0);
  });
});

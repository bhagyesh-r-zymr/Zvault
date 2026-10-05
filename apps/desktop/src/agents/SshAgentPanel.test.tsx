/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- test doubles */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { settleOnUnmount } from '../test/settle.js';
import { mockCore } from '../test/tauri.js';
import type { ActivityEntry, SshAgentStatus } from './api.js';
import { SshAgentPanel } from './SshAgentPanel.js';

const off: SshAgentStatus = { enabled: false, listening: false, socketPath: null, error: null };

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    at: 1_760_000_000,
    agentId: 'ssh',
    agentName: 'ssh',
    outcome: 'allowed',
    refs: [],
    purpose: null,
    reason: null,
    verifiedBy: null,
    peerPid: 1,
    ...over,
  };
}

settleOnUnmount();

describe('SshAgentPanel', () => {
  it('toggles the agent on and reports where it listens', async () => {
    const user = userEvent.setup();
    const calls = mockCore({
      ssh_agent_status: off,
      agent_activity: [],
      ssh_agent_set_enabled: {
        enabled: true,
        listening: true,
        socketPath: '/tmp/zv.sock',
        error: null,
      },
    });
    render(<SshAgentPanel />);
    expect(await screen.findByText(/Off\. ssh and git/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(await screen.findByText('Listening at /tmp/zv.sock')).toBeInTheDocument();
    expect(calls).toHaveBeenCalledWith('ssh_agent_set_enabled', { enabled: true });
    expect(screen.queryByText('Recent use')).not.toBeInTheDocument();
  });

  it('shows agent errors and toggle failures', async () => {
    const user = userEvent.setup();
    mockCore({
      ssh_agent_status: { ...off, error: 'Socket busy' },
      agent_activity: () => Promise.reject(new Error('x')),
      ssh_agent_set_enabled: () => Promise.reject('denied by OS'),
    });
    render(<SshAgentPanel />);
    expect(await screen.findByText('Socket busy')).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(await screen.findByText(/denied by OS/)).toBeInTheDocument();
  });

  it('shows a status error', async () => {
    mockCore({
      ssh_agent_status: () => Promise.reject('no agent'),
      agent_activity: [],
    });
    render(<SshAgentPanel />);
    expect(await screen.findByText(/no agent/)).toBeInTheDocument();
  });

  it('lists recent signatures', async () => {
    mockCore({
      ssh_agent_status: { ...off, enabled: true, listening: true },
      agent_activity: [
        entry({ outcome: 'denied', peerPid: 2 }),
        entry({
          verifiedBy: 'touchId',
          purpose: { kind: 'sshSign', command: [], cwd: null, detail: 'Sign for git' },
          peerPid: 3,
        }),
        entry({ agentName: 'git', peerPid: null }),
      ],
    });
    render(<SshAgentPanel />);
    expect(await screen.findByText('Recent use')).toBeInTheDocument();
    expect(screen.getByText('Sign for git')).toBeInTheDocument();
    expect(screen.getAllByText('Signed with an SSH key')).toHaveLength(2);
    expect(screen.getByText(/denied/)).toBeInTheDocument();
    expect(screen.getAllByText(/Touch ID/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/Listening at/)).toBeInTheDocument());
  });
});

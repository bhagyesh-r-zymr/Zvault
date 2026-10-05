/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- test doubles */
import { emit } from '@tauri-apps/api/event';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { settleOnUnmount } from '../test/settle.js';
import { mockCore } from '../test/tauri.js';
import type { ApprovalPrompt, PairingPrompt, Purpose } from './api.js';
import { AgentPrompts } from './AgentPrompts.js';

settleOnUnmount();

const purpose = (over: Partial<Purpose> = {}): Purpose => ({
  kind: 'run',
  command: ['npm', 'test'],
  cwd: '/work',
  ...over,
});

const approval = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  requestId: 'req1',
  principal: 'agent',
  agentId: 'a1',
  agentName: 'Claude Code',
  refs: ['zv://web/dev/KEY'],
  purpose: purpose(),
  peerPid: 42,
  approval: 'askEveryTime',
  touchId: false,
  expiresInSecs: 60,
  ...over,
});

const pairing = (over: Partial<PairingPrompt> = {}): PairingPrompt => ({
  requestId: 'pair1',
  kind: 'agent',
  name: 'Claude Code',
  code: '123456',
  peerPid: 7,
  expiresInSecs: 120,
  ...over,
});

async function mount(handlers: Record<string, unknown> = {}) {
  const calls = mockCore({
    agent_approval_respond: undefined,
    agent_pairing_respond: undefined,
    ...handlers,
  });
  render(<AgentPrompts />);
  // Let the listeners register.
  await new Promise((r) => setTimeout(r, 0));
  return calls;
}

describe('AgentPrompts approvals', () => {
  it('renders nothing until a request arrives', async () => {
    await mount();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks about a command and approves it', async () => {
    const user = userEvent.setup();
    const calls = await mount();
    await emit('agent://approval-request', approval({ touchId: true }));
    expect(
      await screen.findByText('Claude Code wants to run a command with 1 secret'),
    ).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('/work')).toBeInTheDocument();
    expect(screen.getByText('pid 42 via zv')).toBeInTheDocument();
    expect(screen.getByText('Paired agent, key matches')).toBeInTheDocument();
    expect(screen.getByText(/masked in its output/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Allow with Touch ID/ }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_approval_respond', {
        requestId: 'req1',
        approve: true,
      }),
    );
    await waitFor(() => expect(screen.queryByText(/wants to run/)).not.toBeInTheDocument());
  });

  it('denies and shows an error if answering fails', async () => {
    const user = userEvent.setup();
    await mount({ agent_approval_respond: () => Promise.reject(new Error('gone')) });
    await emit('agent://approval-request', approval({ refs: [], peerPid: null }));
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('gone')).toBeInTheDocument();
  });

  it('describes a terminal change with a destructive warning', async () => {
    await mount();
    await emit(
      'agent://approval-request',
      approval({
        principal: 'user',
        agentId: null,
        approval: null,
        refs: ['a', 'b'],
        purpose: purpose({
          kind: 'change',
          command: [],
          cwd: null,
          detail: 'Delete project web',
          destructive: true,
        }),
      }),
    );
    expect(
      await screen.findByText('Your terminal wants to make a change 2 secrets'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Delete project web/)).toHaveTextContent('This cannot be undone.');
    expect(screen.getByText('From zv in a terminal on this Mac')).toBeInTheDocument();
    expect(screen.getByText('pid 42 via zv')).toBeInTheDocument();
  });

  it('explains SSH signing', async () => {
    await mount();
    await emit(
      'agent://approval-request',
      approval({
        principal: 'ssh',
        agentName: 'git',
        refs: [],
        purpose: purpose({ kind: 'sshSign', command: [], cwd: null }),
      }),
    );
    expect(await screen.findByText('git wants to use an SSH key')).toBeInTheDocument();
    expect(screen.getByText('git, pid 42')).toBeInTheDocument();
    expect(screen.getByText(/private key never leaves the app/)).toBeInTheDocument();
    expect(screen.getByText('Through Zvault’s SSH agent on this Mac')).toBeInTheDocument();
  });

  it('explains browser fills and saved logins', async () => {
    await mount();
    await emit(
      'agent://approval-request',
      approval({ refs: [], purpose: purpose({ kind: 'fill', command: [], cwd: null }) }),
    );
    expect(await screen.findByText(/wants to fill a login/)).toBeInTheDocument();
    expect(screen.getByText('Paired browser extension, key matches')).toBeInTheDocument();
    expect(screen.getByText(/checked this login is saved/)).toBeInTheDocument();
  });

  it('shows saved-login wording', async () => {
    await mount();
    await emit(
      'agent://approval-request',
      approval({
        requestId: 'req2',
        refs: [],
        purpose: purpose({ kind: 'saveLogin', command: [], cwd: null }),
      }),
    );
    expect(await screen.findByText(/typed into this website/)).toBeInTheDocument();
  });

  it('shows requests one at a time and drops closed ones', async () => {
    await mount();
    await emit('agent://approval-request', approval({ requestId: 'x1' }));
    await emit('agent://approval-request', approval({ requestId: 'x2', agentName: 'Second' }));
    expect(await screen.findByText(/Claude Code wants/)).toBeInTheDocument();
    expect(screen.queryByText(/Second wants/)).not.toBeInTheDocument();
    await emit('agent://prompt-closed', 'x1');
    expect(await screen.findByText(/Second wants/)).toBeInTheDocument();
  });
});

describe('AgentPrompts pairing', () => {
  it('validates scopes before pairing an agent', async () => {
    const user = userEvent.setup();
    const calls = await mount();
    await emit('agent://pairing-request', pairing());
    expect(await screen.findByText('Pair Claude Code?')).toBeInTheDocument();
    expect(screen.getByText('123456')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pair agent' }));
    expect(await screen.findByText(/Add at least one place/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Secrets it can use'), 'https://nope');
    await user.click(screen.getByRole('button', { name: 'Pair agent' }));
    expect(await screen.findByText(/https:\/\/nope is not a zv:\/\/ path/)).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalledWith('agent_pairing_respond', expect.anything());
  });

  it('pairs an agent with scopes and a chosen policy', async () => {
    const user = userEvent.setup();
    const calls = await mount();
    await emit('agent://pairing-request', pairing({ peerPid: null }));
    await user.type(
      await screen.findByLabelText('Secrets it can use'),
      'zv://web/development/*, zv://pay/prod/KEY',
    );
    await user.click(screen.getByRole('radio', { name: /Allow while Zvault is unlocked/ }));
    await user.click(screen.getByRole('button', { name: 'Pair agent' }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_pairing_respond', {
        requestId: 'pair1',
        approve: true,
        approval: 'whileUnlocked',
        scopes: ['zv://web/development/*', 'zv://pay/prod/KEY'],
      }),
    );
  });

  it('declines an agent without needing scopes, and reports failure', async () => {
    const user = userEvent.setup();
    const calls = await mount({
      agent_pairing_respond: () => Promise.reject(new Error('timed out')),
    });
    await emit('agent://pairing-request', pairing());
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('timed out')).toBeInTheDocument();
    expect(calls).toHaveBeenCalledWith('agent_pairing_respond', {
      requestId: 'pair1',
      approve: false,
    });
  });

  it('connects the browser extension with a mode', async () => {
    const user = userEvent.setup();
    const calls = await mount();
    await emit('agent://pairing-request', pairing({ kind: 'browser', name: 'Zvault for Chrome' }));
    expect(await screen.findByText('Connect Zvault for Chrome?')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Ask me each time/ }));
    await user.click(screen.getByRole('button', { name: 'Connect browser' }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('agent_pairing_respond', {
        requestId: 'pair1',
        approve: true,
        approval: 'askEveryTime',
        scopes: [],
      }),
    );
  });

  it('declines the browser extension and shows errors', async () => {
    const user = userEvent.setup();
    await mount({ agent_pairing_respond: () => Promise.reject('nope') });
    await emit('agent://pairing-request', pairing({ kind: 'browser' }));
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});

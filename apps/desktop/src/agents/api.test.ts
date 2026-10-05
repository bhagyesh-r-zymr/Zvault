import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { agents, sshAgent } from './api.js';

describe('agents invoke wrappers', () => {
  it('passes arguments to the matching commands', async () => {
    const calls = mockCore({
      agent_access_status: { listening: true, socketPath: '/s' },
      agent_list: [],
      agent_update: {},
      agent_unpair: undefined,
      agent_activity: [],
      agent_approval_respond: undefined,
      agent_pairing_respond: undefined,
      cli_status: { bundled: true, installedAt: null, onPath: false, command: null },
      cli_install: { path: '/p', onPath: true, pathLine: null },
      browser_extension_status: { bundled: true, browsers: [], extensionId: 'x' },
      ssh_agent_status: { enabled: false, listening: false, socketPath: null, error: null },
      ssh_agent_set_enabled: { enabled: true, listening: true, socketPath: null, error: null },
    });
    await agents.accessStatus();
    await agents.list();
    await agents.update('a1', { paused: true });
    await agents.unpair('a1');
    await agents.activity('a1', 5);
    await agents.approve('r1', true);
    await agents.answerPairing('r2', true, { approval: 'session15m', scopes: ['zv://a/b/*'] });
    await agents.answerPairing('r3', false);
    await agents.cliStatus();
    await agents.installCli();
    await agents.installCli(true);
    await agents.browserExtensionStatus();
    await sshAgent.status();
    await sshAgent.setEnabled(true);
    await sshAgent.activity();
    expect(calls).toHaveBeenCalledWith('agent_update', { agentId: 'a1', paused: true });
    expect(calls).toHaveBeenCalledWith('agent_activity', { agentId: 'a1', limit: 5 });
    expect(calls).toHaveBeenCalledWith('agent_approval_respond', {
      requestId: 'r1',
      approve: true,
    });
    expect(calls).toHaveBeenCalledWith('agent_pairing_respond', {
      requestId: 'r2',
      approve: true,
      approval: 'session15m',
      scopes: ['zv://a/b/*'],
    });
    expect(calls).toHaveBeenCalledWith('cli_install', { admin: false });
    expect(calls).toHaveBeenCalledWith('cli_install', { admin: true });
    expect(calls).toHaveBeenCalledWith('agent_activity', { agentId: 'ssh', limit: 8 });
  });
});

describe('agents event listeners', () => {
  async function listens(
    register: (h: never) => Promise<() => void>,
    event: string,
    payload: unknown,
    expected: unknown,
  ) {
    mockCore();
    const handler = vi.fn();
    const unlisten = await register(handler as never);
    await emit(event, payload);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    if (expected !== undefined) expect(handler).toHaveBeenCalledWith(expected);
    unlisten();
  }

  it('delivers payloads to each handler', async () => {
    await listens(
      agents.onApprovalRequest,
      'agent://approval-request',
      { requestId: 'a' },
      { requestId: 'a' },
    );
    await listens(
      agents.onPairingRequest,
      'agent://pairing-request',
      { requestId: 'b' },
      { requestId: 'b' },
    );
    await listens(agents.onPromptClosed, 'agent://prompt-closed', 'c', 'c');
    await listens(agents.onActivity, 'agent://activity', null, undefined);
    await listens(agents.onUnlockRequested, 'agent://unlock-requested', null, undefined);
  });
});

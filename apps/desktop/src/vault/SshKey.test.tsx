import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeServer, makeCore, VAULT } from '../test/vaultFakes.js';
import { SshKeyEditor, SshKeyPanel, SSH_AGENT_SOCKET } from './SshKey.js';
import { VaultSync } from './sync.js';

describe('SshKeyPanel', () => {
  it('shows the public key, fingerprint and name', () => {
    render(
      <SshKeyPanel
        sshKey={{
          comment: 'laptop',
          keyType: 'Ed25519',
          publicKey: 'ssh-ed25519 AAAA laptop',
          fingerprint: 'SHA256:abc',
          createdAt: 1_700_000_000,
        }}
      />,
    );
    expect(screen.getByText('SSH key · Ed25519')).toBeInTheDocument();
    expect(screen.getByText('ssh-ed25519 AAAA laptop')).toBeInTheDocument();
    expect(screen.getByText('SHA256:abc')).toBeInTheDocument();
    expect(screen.getByText('laptop')).toBeInTheDocument();
    expect(SSH_AGENT_SOCKET).toContain('ssh-agent.sock');
  });

  it('omits the name row and creation date when absent', () => {
    render(<SshKeyPanel sshKey={{ comment: '' }} />);
    expect(screen.queryByText('key name')).not.toBeInTheDocument();
    expect(screen.getByText('Created —')).toBeInTheDocument();
  });
});

function editor() {
  const server = new FakeServer();
  const sync = new VaultSync(server.asApi(), makeCore(), VAULT);
  const save = vi.spyOn(sync, 'save');
  const onDone = vi.fn();
  render(<SshKeyEditor sync={sync} onDone={onDone} />);
  return { save, onDone };
}

describe('SshKeyEditor', () => {
  it('generates a key named after the title', async () => {
    const { save, onDone } = editor();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title'), 'GitHub');
    await user.click(screen.getByRole('button', { name: 'Generate key' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ title: 'GitHub', sshKey: { comment: 'GitHub' } }),
    );
  });

  it('uses an explicit key name', async () => {
    const { save } = editor();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title'), 'GitHub');
    await user.type(screen.getByLabelText(/Key name/), ' me@laptop ');
    await user.click(screen.getByRole('button', { name: 'Generate key' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![1].sshKey).toEqual({ comment: 'me@laptop' });
  });

  it('imports a private key with a passphrase', async () => {
    const { save, onDone } = editor();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Import existing' }));
    await user.type(screen.getByLabelText('Title'), 'Server');
    await user.type(screen.getByLabelText(/Private key/), 'KEY');
    await user.type(screen.getByLabelText(/Passphrase/), 'secret');
    await user.type(screen.getByLabelText('Notes'), 'prod');
    await user.click(screen.getByRole('button', { name: 'Import key' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        title: 'Server',
        notes: 'prod',
        sshKey: { comment: '', privateKey: 'KEY', passphrase: 'secret' },
      }),
    );
  });

  it('shows save errors and cancels', async () => {
    const { save, onDone } = editor();
    save.mockRejectedValueOnce(new Error('invalid key'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title'), 'X');
    await user.click(screen.getByRole('button', { name: 'Generate key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid key');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

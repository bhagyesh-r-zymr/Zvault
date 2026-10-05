import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeServer, makeCore, VAULT } from '../test/vaultFakes.js';
import { PasskeyEditor, PasskeyPanel } from './Passkey.js';
import { VaultSync } from './sync.js';

const passkey = {
  rpId: 'github.com',
  userName: 'octocat',
  credentialId: 'abcdefghijklmnopqrstuvwxyz0123456789',
  publicKey: 'short',
  createdAt: 1_700_000_000,
};

describe('PasskeyPanel', () => {
  it('shows public details with shortened ids', () => {
    render(<PasskeyPanel passkey={passkey} onTest={vi.fn()} />);
    expect(screen.getByText('Sign in to github.com without a password')).toBeInTheDocument();
    expect(screen.getByText('abcdefgh…456789')).toBeInTheDocument();
    expect(screen.getByText('short')).toBeInTheDocument();
    expect(screen.getByText(/Created \w{3}/)).toBeInTheDocument();
  });

  it('copes with missing optional details', () => {
    render(<PasskeyPanel passkey={{ rpId: 'a.co', userName: 'u' }} onTest={vi.fn()} />);
    expect(screen.getByText('Created —')).toBeInTheDocument();
  });

  it('runs the test sign-in', async () => {
    const onTest = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PasskeyPanel passkey={passkey} onTest={onTest} />);
    await user.click(screen.getByRole('button', { name: /Test sign-in/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('verified it with the public key');
  });

  it('reports a failed test', async () => {
    const onTest = vi.fn().mockRejectedValue(new Error('bad signature'));
    const user = userEvent.setup();
    render(<PasskeyPanel passkey={passkey} onTest={onTest} />);
    await user.click(screen.getByRole('button', { name: /Test sign-in/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad signature');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

function editor() {
  const server = new FakeServer();
  const sync = new VaultSync(server.asApi(), makeCore(), VAULT);
  const save = vi.spyOn(sync, 'save');
  const onDone = vi.fn();
  render(<PasskeyEditor sync={sync} onDone={onDone} />);
  return { save, onDone };
}

describe('PasskeyEditor', () => {
  it('creates a passkey for a site', async () => {
    const { save, onDone } = editor();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Website'), 'github.com');
    await user.type(screen.getByLabelText('User name'), 'octocat');
    await user.click(screen.getByRole('button', { name: 'Create passkey' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        title: 'github.com',
        username: 'octocat',
        urls: ['https://github.com'],
        passkey: { rpId: 'github.com', userName: 'octocat' },
      }),
    );
  });

  it('imports an existing passkey with a custom title', async () => {
    const { save, onDone } = editor();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Import existing' }));
    await user.type(screen.getByLabelText('Website'), 'https://example.com/login');
    await user.type(screen.getByLabelText('User name'), 'me');
    await user.type(screen.getByLabelText('Title'), '  Work  ');
    await user.type(screen.getByLabelText(/Credential ID/), 'cred');
    await user.type(screen.getByLabelText(/User handle/), 'handle');
    await user.type(screen.getByLabelText(/Private key/), 'PEM');
    await user.type(screen.getByLabelText('Notes'), 'n');
    await user.click(screen.getByRole('button', { name: 'Import passkey' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        title: 'Work',
        urls: ['https://example.com/login'],
        notes: 'n',
        passkey: {
          rpId: 'https://example.com/login',
          userName: 'me',
          credentialId: 'cred',
          userHandle: 'handle',
          privateKey: 'PEM',
        },
      }),
    );
  });

  it('shows save errors and cancels', async () => {
    const { save, onDone } = editor();
    save.mockRejectedValueOnce(new Error('quota'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Website'), 'a.co');
    await user.type(screen.getByLabelText('User name'), 'u');
    await user.click(screen.getByRole('button', { name: 'Create passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota');
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

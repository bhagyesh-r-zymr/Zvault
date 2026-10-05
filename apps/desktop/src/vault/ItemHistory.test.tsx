import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeServer, login, makeCore, VAULT } from '../test/vaultFakes.js';
import { changedFields, ItemHistory } from './ItemHistory.js';
import { VaultSync } from './sync.js';

describe('changedFields', () => {
  it('names the fields that differ', () => {
    expect(changedFields(login('A', 'x'), login('A', 'y'))).toEqual(['password']);
    expect(changedFields(login('A'), login('A'))).toEqual([]);
    expect(
      changedFields(
        login('A'),
        login('B', 'pw', { urls: ['https://x.co'], notes: 'n', totp: 't' }),
      ),
    ).toEqual(['title', 'username', 'one-time password', 'website', 'notes']);
  });
});

async function setup() {
  const server = new FakeServer();
  const sync = new VaultSync(server.asApi(), makeCore(), VAULT);
  const id = await sync.save(null, login('Bank', 'first', { urls: ['https://bank.co'] }));
  await sync.save(id, login('Bank', 'second', { urls: ['https://bank.co'] }));
  const current = await sync.open(id);
  return { sync, id, current };
}

describe('ItemHistory', () => {
  it('lists earlier versions, reveals the password and restores', async () => {
    const { sync, id, current } = await setup();
    const onRestored = vi.fn();
    const user = userEvent.setup();
    render(<ItemHistory sync={sync} id={id} current={current} onRestored={onRestored} />);
    expect(await screen.findByText('Differs in password')).toBeInTheDocument();
    expect(screen.getByText('https://bank.co')).toBeInTheDocument();
    expect(screen.getByLabelText('Hidden')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText('first')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByLabelText('Hidden')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Restore/ }));
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect((await sync.open(id)).password).toBe('first');
  });

  it('says so when there are no earlier versions', async () => {
    const server = new FakeServer();
    const sync = new VaultSync(server.asApi(), makeCore(), VAULT);
    const id = await sync.save(null, login('Bank'));
    render(<ItemHistory sync={sync} id={id} current={login('Bank')} onRestored={vi.fn()} />);
    expect(await screen.findByText(/No earlier versions yet/)).toBeInTheDocument();
  });

  it('disables restore for a version identical to the current one', async () => {
    const { sync, id } = await setup();
    const v = (await sync.history(id))[0]!;
    render(<ItemHistory sync={sync} id={id} current={v.fields} onRestored={vi.fn()} />);
    expect(await screen.findByText('Same as the current version')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeDisabled();
  });

  it('shows errors from loading and from restoring', async () => {
    const { sync, id, current } = await setup();
    vi.spyOn(sync, 'history').mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(
      <ItemHistory sync={sync} id={id} current={current} onRestored={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    unmount();

    vi.spyOn(sync, 'restoreVersion').mockRejectedValueOnce(new Error('conflict'));
    const user = userEvent.setup();
    render(<ItemHistory sync={sync} id={id} current={current} onRestored={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /Restore/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('conflict');
    expect(screen.getByRole('button', { name: /Restore/ })).toBeEnabled();
  });

  it('shows placeholders for empty fields', async () => {
    const server = new FakeServer();
    const sync = new VaultSync(server.asApi(), makeCore(), VAULT);
    const id = await sync.save(null, login('', '', { username: '' }));
    await sync.save(id, login('Named'));
    render(<ItemHistory sync={sync} id={id} current={login('Named')} onRestored={vi.fn()} />);
    expect(await screen.findByText('Untitled')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});

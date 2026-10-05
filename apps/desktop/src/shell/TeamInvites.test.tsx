import type { OrgSummary } from '@zvault/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TeamStore } from '../projects/team.js';
import { TeamError } from '../projects/teamApi.js';
import { TeamInvites } from './TeamInvites.js';

const org = (id: string, name: string, status: OrgSummary['status']): OrgSummary => ({
  id,
  name,
  role: 'member',
  status,
});

function fakeStore(orgs: OrgSummary[], acceptInvite = vi.fn(() => Promise.resolve())) {
  const snapshot = { orgs };
  const store = {
    subscribe: () => () => undefined,
    get: () => snapshot,
    acceptInvite,
  } as unknown as TeamStore;
  return { store, acceptInvite };
}

describe('TeamInvites', () => {
  it('renders nothing without pending invites', () => {
    const { store } = fakeStore([org('1', 'Acme', 'active')]);
    const { container } = render(<TeamInvites store={store} onAccepted={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only invited orgs', () => {
    const { store } = fakeStore([org('1', 'Acme', 'invited'), org('2', 'Done', 'active')]);
    render(<TeamInvites store={store} onAccepted={() => undefined} />);
    expect(screen.getByText('Team invite from Acme')).toBeInTheDocument();
    expect(screen.queryByText(/Done/)).not.toBeInTheDocument();
  });

  it('accepts an invite and reports it', async () => {
    const user = userEvent.setup();
    const onAccepted = vi.fn();
    const { store, acceptInvite } = fakeStore([org('1', 'Acme', 'invited')]);
    render(<TeamInvites store={store} onAccepted={onAccepted} />);
    await user.click(screen.getByRole('button', { name: /Team invite from Acme/ }));
    expect(screen.getByText('Join Acme')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(acceptInvite).toHaveBeenCalledWith('1');
    expect(screen.queryByText('Join Acme')).not.toBeInTheDocument();
  });

  it('can be dismissed with Not now', async () => {
    const user = userEvent.setup();
    const { store, acceptInvite } = fakeStore([org('1', 'Acme', 'invited')]);
    render(<TeamInvites store={store} onAccepted={() => undefined} />);
    await user.click(screen.getByRole('button', { name: /Team invite from Acme/ }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Join Acme')).not.toBeInTheDocument();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('shows why accepting failed and allows retrying', async () => {
    const user = userEvent.setup();
    const accept = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new TeamError(429, 'x'))
      .mockResolvedValueOnce(undefined);
    const onAccepted = vi.fn();
    const { store } = fakeStore([org('1', 'Acme', 'invited')], accept);
    render(<TeamInvites store={store} onAccepted={onAccepted} />);
    await user.click(screen.getByRole('button', { name: /Team invite from Acme/ }));
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    expect(await screen.findByText(/Too many changes at once/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
  });
});

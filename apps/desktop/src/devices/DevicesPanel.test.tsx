/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/prefer-promise-reject-errors -- test doubles */
import type { DeviceSession } from '@zvault/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { DevicesApiError, type DevicesClient } from './client.js';
import { DevicesPanel } from './DevicesPanel.js';
import type { PairingClient } from './pairing.js';

const mac: DeviceSession = {
  id: '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4',
  device: { name: 'Work MacBook', platform: 'macos', appVersion: '0.1.0' },
  createdAt: '2026-09-24T10:00:00.000Z',
  lastSeenAt: '2026-09-24T11:00:00.000Z',
  current: true,
};
const phone: DeviceSession = {
  id: '7f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c5',
  device: { name: 'Pixel', platform: 'android', appVersion: '0.2.0' },
  createdAt: '2026-09-25T10:00:00.000Z',
  lastSeenAt: '2026-09-25T11:00:00.000Z',
  current: false,
};
const tablet: DeviceSession = {
  ...phone,
  id: '8f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c6',
  device: { ...phone.device, name: 'Tab' },
};

function setup(over: Partial<DevicesClient> = {}, list: DeviceSession[] = [mac, phone]) {
  const client: DevicesClient = {
    list: vi.fn(() => Promise.resolve(list)),
    revoke: vi.fn(() => Promise.resolve()),
    revokeOthers: vi.fn(() => Promise.resolve(1)),
    ...over,
  };
  const pairing = {} as PairingClient;
  const onSignedOut = vi.fn();
  render(
    <DevicesPanel
      client={client}
      pairing={pairing}
      apiUrl="https://api.test"
      onSignedOut={onSignedOut}
    />,
  );
  return { client, onSignedOut };
}

describe('DevicesPanel', () => {
  it('lists devices and marks the current one', async () => {
    setup();
    expect(await screen.findByText('Work MacBook')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Pixel')).toBeInTheDocument();
    expect(screen.getByText('Sign out here')).toBeInTheDocument();
    expect(screen.getByText('Sign out 1 other device')).toBeInTheDocument();
  });

  it('shows a loading state before the list arrives', () => {
    setup({ list: () => new Promise(() => undefined) });
    expect(screen.getByText('Loading devices…')).toBeInTheDocument();
  });

  it('revokes another device after inline confirmation, then refreshes', async () => {
    const user = userEvent.setup();
    const { client } = setup();
    await screen.findByText('Pixel');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(client.revoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.revoke).toHaveBeenCalledWith(phone.id));
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  });

  it('signs out other devices in bulk (plural label)', async () => {
    const user = userEvent.setup();
    const { client } = setup({}, [mac, phone, tablet]);
    await user.click(await screen.findByRole('button', { name: 'Sign out 2 other devices' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.revokeOthers).toHaveBeenCalled());
  });

  it('calls onSignedOut after revoking the current session', async () => {
    const user = userEvent.setup();
    const { client, onSignedOut } = setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out here' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    expect(client.revoke).toHaveBeenCalledWith(mac.id);
  });

  it('reports a failure when revoking the current session', async () => {
    const user = userEvent.setup();
    const { onSignedOut } = setup({
      revoke: () => Promise.reject(new DevicesApiError(429, 'Too many attempts.')),
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out here' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts.');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('shows an error when a revoke fails and refreshes', async () => {
    const user = userEvent.setup();
    const { client } = setup({
      revoke: () => Promise.reject(new DevicesApiError(404, 'Already signed out.')),
    });
    await screen.findByText('Pixel');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    // The refresh after a failed revoke succeeds and clears the error.
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('signs out when the list says the session ended', async () => {
    const { onSignedOut } = setup({ list: () => Promise.reject(new DevicesApiError(401, 'gone')) });
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });

  it('shows a generic message for network errors', async () => {
    setup({ list: () => Promise.reject(new Error('offline')) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Zvault');
  });

  it('opens and closes the add-phone sheet', async () => {
    const user = userEvent.setup();
    mockCore({
      pairing_begin: () => Promise.reject('no core'),
      pairing_cancel: undefined,
    });
    setup();
    await screen.findByText('Pixel');
    await user.click(screen.getByRole('button', { name: /Add phone/ }));
    expect(await screen.findByText('Add a phone')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('no core');
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByText('Add a phone')).not.toBeInTheDocument();
  });
});

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/prefer-promise-reject-errors -- test doubles */
import type { PairingView } from '@zvault/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { AddPhoneSheet } from './AddPhoneSheet.js';
import { DevicesApiError } from './client.js';
import type { PairingClient } from './pairing.js';

const ID = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4';
const KEY = 'A'.repeat(43) as PairingView['publicKey'] & string;
const device = { name: 'Pixel 9', platform: 'android' as const, appVersion: '1.0.0' };
const future = () => new Date(Date.now() + 120_000).toISOString();
const claimed: PairingView = {
  id: ID,
  status: 'claimed',
  expiresAt: future(),
  device,
  publicKey: KEY,
};

function core(over: Record<string, unknown> = {}) {
  return mockCore({
    pairing_begin: { claimToken: 'tok' },
    pairing_qr: 'zvault://pair?id=abc',
    pairing_code: '472918',
    pairing_grant: { ephemeralPublicKey: KEY, nonce: 'n', ct: 'c' },
    pairing_cancel: undefined,
    ...over,
  });
}

function setup(over: Partial<PairingClient> = {}) {
  const client: PairingClient = {
    create: vi.fn(() => Promise.resolve({ id: ID, expiresAt: future() })),
    get: vi.fn(() =>
      Promise.resolve({ ...claimed, status: 'waiting' as const, device: null, publicKey: null }),
    ),
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(() => Promise.resolve()),
    ...over,
  };
  const h = { onClose: vi.fn(), onAdded: vi.fn(), onSignedOut: vi.fn() };
  render(<AddPhoneSheet client={client} apiUrl="https://api.test" {...h} />);
  return { client, ...h };
}

describe('AddPhoneSheet', () => {
  it('shows a QR code and the URI as text on request', async () => {
    const user = userEvent.setup();
    core();
    setup();
    expect(await screen.findByAltText('QR code to sign in on your phone')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for your phone/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show it as text/ }));
    expect(screen.getByText('zvault://pair?id=abc')).toBeInTheDocument();
  });

  it('walks through scan, confirm, allow and done', async () => {
    const user = userEvent.setup();
    const calls = core();
    const { client, onAdded, onClose } = setup({ get: vi.fn(() => Promise.resolve(claimed)) });
    expect(await screen.findByText('472 918', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Pixel 9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText(/is signed in/)).toBeInTheDocument();
    expect(client.approve).toHaveBeenCalledWith(ID, expect.objectContaining({ nonce: 'n' }));
    expect(calls).toHaveBeenCalledWith('pairing_grant', { publicKey: KEY });
    expect(onAdded).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  }, 15000);

  it('denies a phone and closes', async () => {
    const user = userEvent.setup();
    const calls = core();
    const { client, onClose } = setup({ get: vi.fn(() => Promise.resolve(claimed)) });
    await user.click(await screen.findByRole('button', { name: 'Deny' }, { timeout: 5000 }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.deny).toHaveBeenCalledWith(ID);
    expect(calls).toHaveBeenCalledWith('pairing_cancel', {});
  }, 15000);

  it('fails when approving fails, and can try again', async () => {
    const user = userEvent.setup();
    core();
    const { client } = setup({
      get: vi.fn(() => Promise.resolve(claimed)),
      approve: vi.fn(() => Promise.reject(new DevicesApiError(409, 'No longer waiting.'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Allow' }, { timeout: 5000 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No longer waiting.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(2));
  }, 15000);

  it('fails when deny fails', async () => {
    const user = userEvent.setup();
    core();
    setup({
      get: vi.fn(() => Promise.resolve(claimed)),
      deny: vi.fn(() => Promise.reject(new DevicesApiError(429, 'Slow down.'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Deny' }, { timeout: 5000 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Slow down.');
  }, 15000);

  it('shows string errors from the core and closes via Close', async () => {
    const user = userEvent.setup();
    core({ pairing_begin: () => Promise.reject('Keychain locked') });
    const { onClose } = setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Keychain locked');
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a generic message for unknown errors', async () => {
    core();
    setup({ create: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Zvault');
  });

  it('returns to sign-in when the session is gone', async () => {
    core();
    const { onSignedOut } = setup({ create: () => Promise.reject(new DevicesApiError(401, 'x')) });
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });

  it('offers a new code once the QR code expires', async () => {
    const user = userEvent.setup();
    core();
    const create = vi.fn(() =>
      Promise.resolve({ id: ID, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    setup({ create });
    expect(await screen.findByText('This code has expired.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New code/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('fails when polling errors', async () => {
    core();
    setup({ get: vi.fn(() => Promise.reject(new DevicesApiError(404, 'Code expired.'))) });
    expect(
      await screen.findByText('Code expired.', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 15000);
});

import type { IncomingUserShare, OutgoingUserShare, ShareLinkSummary } from '@zvault/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mockCore } from '../test/tauri.js';
import type { SharingApi } from './api.js';
import { blob, ID, ID2, ID3, ID4, KEY, OTHER_KEY } from './fixtures.js';
import { SharingCenter } from './SharingCenter.js';

const DATE = '2026-01-01T00:00:00.000Z';

const incoming: IncomingUserShare = {
  id: ID,
  sender: { userId: 'u1', email: 'alice@example.com', publicKey: OTHER_KEY },
  ephemeralPublicKey: KEY,
  blob: blob('share-box'),
  createdAt: DATE,
  expiresAt: null,
};
const outgoing: OutgoingUserShare = {
  id: ID2,
  recipient: { userId: 'u2', email: 'bob@example.com' },
  createdAt: DATE,
  expiresAt: DATE,
};
const link = (over: Partial<ShareLinkSummary>): ShareLinkSummary => ({
  id: ID3,
  createdAt: DATE,
  expiresAt: DATE,
  maxViews: 3,
  viewCount: 1,
  allowedEmailCount: 0,
  status: 'active',
  ...over,
});

type Mocked = { [K in keyof SharingApi]: Mock };

function fakeApi(over: Partial<Record<keyof SharingApi, unknown>> = {}): Mocked {
  return {
    publishKey: vi.fn().mockResolvedValue({}),
    listUserShares: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
    listLinks: vi.fn().mockResolvedValue({ links: [] }),
    removeUserShare: vi.fn().mockResolvedValue(undefined),
    revokeLink: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as Mocked;
}

const baseCore = {
  sharing_identity: { publicKey: KEY, fingerprint: 'MY-CODE' },
  sharing_fingerprint: 'THEIR-CODE',
};

beforeEach(() => localStorage.clear());

describe('SharingCenter', () => {
  it('shows my security code and empty states', async () => {
    mockCore(baseCore);
    const api = fakeApi();
    render(<SharingCenter api={api as unknown as SharingApi} />);
    expect(await screen.findByText('MY-CODE')).toBeInTheDocument();
    expect(api.publishKey).toHaveBeenCalledWith(KEY);
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
    expect(screen.getByText('No links yet.')).toBeInTheDocument();
    expect(screen.getByText(/Share an item or a project secret/)).toBeInTheDocument();
  });

  it('shows an error when loading fails and recovers on refresh', async () => {
    mockCore(baseCore);
    const api = fakeApi({ listLinks: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    api.listLinks.mockResolvedValue({ links: [] });
    const user = userEvent.setup();
    render(<SharingCenter api={api as unknown as SharingApi} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('No links yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lists outgoing shares and revokes one', async () => {
    mockCore(baseCore);
    const api = fakeApi({
      listUserShares: vi.fn().mockResolvedValue({ incoming: [], outgoing: [outgoing] }),
    });
    const user = userEvent.setup();
    render(<SharingCenter api={api as unknown as SharingApi} />);
    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(api.removeUserShare).toHaveBeenCalledWith(outgoing.id);
    expect(api.listLinks.mock.calls.length).toBeGreaterThan(1);
  });

  it('lists links and revokes only active ones', async () => {
    mockCore(baseCore);
    const api = fakeApi({
      listLinks: vi.fn().mockResolvedValue({
        links: [
          link({ allowedEmailCount: 1 }),
          link({ id: ID4, status: 'expired', allowedEmailCount: 2 }),
        ],
      }),
    });
    const user = userEvent.setup();
    render(<SharingCenter api={api as unknown as SharingApi} />);
    expect(await screen.findByText(/Only 1 person ·/)).toBeInTheDocument();
    expect(screen.getByText(/Only 2 people ·/)).toBeInTheDocument();
    expect(screen.getAllByText('1 of 3 views')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(api.revokeLink).toHaveBeenCalledWith(ID3);
  });

  it('shows an error when a removal fails', async () => {
    mockCore(baseCore);
    const api = fakeApi({
      listLinks: vi.fn().mockResolvedValue({ links: [link({})] }),
      revokeLink: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const user = userEvent.setup();
    render(<SharingCenter api={api as unknown as SharingApi} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('denied');
  });

  describe('incoming share', () => {
    const payload = {
      v: 1,
      title: 'Netflix',
      username: 'alice',
      password: 'hunter2',
      url: 'https://netflix.com',
      notes: 'family plan',
      totp: 'otpauth://totp/N:a?secret=ABC',
      passkey: {
        rpId: 'netflix.com',
        userName: 'alice',
        userHandle: 'h',
        credentialId: 'c',
        privateKey: 'PEM',
      },
      secret: { key: 'API_KEY', project: 'App', environment: 'Prod' },
    };

    const mountIncoming = (core: Record<string, unknown>) => {
      const api = fakeApi({
        listUserShares: vi.fn().mockResolvedValue({ incoming: [incoming], outgoing: [] }),
      });
      mockCore({ ...baseCore, ...core });
      render(<SharingCenter api={api as unknown as SharingApi} />);
      return api;
    };

    it('decrypts, shows every field and pins the sender', async () => {
      mountIncoming({
        share_open: JSON.stringify(payload),
        otp_code: { code: '123456', period: 30, remaining: 20 },
      });
      const user = userEvent.setup();
      expect(await screen.findByText('From alice@example.com')).toBeInTheDocument();
      expect(await screen.findByText('THEIR-CODE')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByText('Netflix')).toBeInTheDocument();
      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText(/project secret · App \/ Prod/)).toBeInTheDocument();
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
      expect(screen.getByText('https://netflix.com')).toBeInTheDocument();
      expect(screen.getByText('alice on netflix.com')).toBeInTheDocument();
      expect(screen.getByText('family plan')).toBeInTheDocument();
      expect(await screen.findByLabelText('One-time password')).toHaveTextContent('123 456');
      expect(screen.getByRole('button', { name: 'Copy private key' })).toBeInTheDocument();
      expect(screen.getByText('value')).toBeInTheDocument();
      expect(localStorage.getItem('zvault.sharing.pins.v1')).toContain(OTHER_KEY);
    });

    it('shows a plain login with a password label', async () => {
      mountIncoming({ share_open: JSON.stringify({ v: 1, title: 'Site', password: 'pw' }) });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Open' }));
      expect(await screen.findByText('password')).toBeInTheDocument();
    });

    it('explains when decryption fails', async () => {
      mountIncoming({
        share_open: () => {
          throw new Error('bad key');
        },
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Open' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not decrypt');
    });

    it('warns when the sender key changed', async () => {
      localStorage.setItem('zvault.sharing.pins.v1', JSON.stringify({ 'alice@example.com': KEY }));
      mountIncoming({ share_open: JSON.stringify({ v: 1, title: 'X' }) });
      expect(await screen.findByRole('alert')).toHaveTextContent('security code has changed');
      expect(screen.getByRole('button', { name: 'Open anyway' })).toBeInTheDocument();
    });

    it('removes a share', async () => {
      const api = mountIncoming({});
      const user = userEvent.setup();
      const row = (await screen.findByText('From alice@example.com')).closest('li')!;
      await user.click(within(row).getByRole('button', { name: 'Remove' }));
      expect(api.removeUserShare).toHaveBeenCalledWith(ID);
    });

    it('copes with a fingerprint failure', async () => {
      mountIncoming({
        sharing_fingerprint: () => {
          throw new Error('x');
        },
      });
      expect(await screen.findByText('From alice@example.com')).toBeInTheDocument();
      expect(screen.queryByText(/security code/)).toBeInTheDocument();
    });
  });
});

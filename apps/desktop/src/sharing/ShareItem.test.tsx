import type { SharedItemPayload } from '@zvault/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import type { SharingApi } from './api.js';
import { blob, ID, KEY, OTHER_KEY } from './fixtures.js';
import { ShareItem, withoutTotp } from './ShareItem.js';

const item: SharedItemPayload = {
  v: 1,
  title: 'GitHub',
  username: 'me',
  password: 'pw',
  totp: 'otpauth://totp/GitHub:me?secret=ABC',
};

const summary = {
  id: ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-08T00:00:00.000Z',
  maxViews: 1,
  viewCount: 0,
  allowedEmailCount: 0,
  status: 'active' as const,
  unverifiedEmails: [] as string[],
};

function fakeApi(over: Partial<SharingApi> = {}): SharingApi {
  return {
    createLink: vi.fn().mockResolvedValue(summary),
    listLinks: vi.fn(),
    revokeLink: vi.fn(),
    publishKey: vi.fn().mockResolvedValue({}),
    lookupKey: vi.fn().mockResolvedValue({ userId: 'u', email: 'bob@example.com', publicKey: KEY }),
    shareWithUser: vi.fn().mockResolvedValue({}),
    listUserShares: vi.fn(),
    removeUserShare: vi.fn(),
    ...over,
  };
}

const linkCore = () =>
  mockCore({
    share_link_create: (a: Record<string, unknown>) => ({
      id: ID,
      verifier: KEY,
      blob: blob('share-link'),
      url: 'http://share/#key',
      payload: a.payload,
    }),
    share_compose_email: null,
  });

beforeEach(() => {
  localStorage.clear();
});

describe('withoutTotp', () => {
  it('drops the 2FA setup only', () => {
    expect(withoutTotp(item)).toEqual({ v: 1, title: 'GitHub', username: 'me', password: 'pw' });
  });
});

describe('ShareItem by link', () => {
  it('creates a link without 2FA by default and reports the share', async () => {
    const calls = linkCore();
    const api = fakeApi();
    const onShared = vi.fn();
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} onShared={onShared} />);
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByLabelText('Share link')).toHaveValue('http://share/#key');
    const payload = JSON.parse(calls.mock.calls[0]![1].payload as string) as SharedItemPayload;
    expect(payload.totp).toBeUndefined();
    expect(api.createLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, expiresInSeconds: 7 * 86400, maxViews: 1 }),
    );
    expect(onShared).toHaveBeenCalledWith('link');
    expect(screen.getByText(/Anyone with this link can view the item/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make another link' }));
    expect(screen.getByRole('button', { name: /Create secure link/ })).toBeInTheDocument();
  });

  it('includes 2FA when switched on, with chosen expiry and views', async () => {
    const calls = linkCore();
    const api = fakeApi();
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} />);
    await user.click(screen.getByRole('switch'));
    expect(screen.getByText(/can sign in without you/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '1 hour' }));
    const views = screen.getByLabelText('Views allowed');
    await user.clear(views);
    await user.type(views, '500');
    expect(views).toHaveValue(100);
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    await screen.findByLabelText('Share link');
    const payload = JSON.parse(calls.mock.calls[0]![1].payload as string) as SharedItemPayload;
    expect(payload.totp).toBe(item.totp);
    expect(api.createLink).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 3600, maxViews: 100 }),
    );
    expect(screen.getByText(/after 100 views/)).toBeInTheDocument();
  });

  it('describes a project secret', async () => {
    linkCore();
    const user = userEvent.setup();
    render(
      <ShareItem
        item={{
          v: 1,
          title: 'DB',
          password: 'x',
          secret: { key: 'DATABASE_URL', project: 'App', environment: 'Staging' },
        }}
        api={fakeApi()}
      />,
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByText(/can view the secret/)).toBeInTheDocument();
  });

  it('validates the emails of a restricted link', async () => {
    linkCore();
    const api = fakeApi();
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} />);
    await user.click(screen.getByRole('radio', { name: /Only people with these emails/ }));
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add at least one email.');
    await user.type(screen.getByPlaceholderText(/name@company/), 'nope');
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope is not an email address.');
    expect(api.createLink).not.toHaveBeenCalled();
  });

  it('creates a restricted link, warns about unverified emails and drafts a mail', async () => {
    const calls = linkCore();
    const api = fakeApi({
      createLink: vi.fn().mockResolvedValue({ ...summary, unverifiedEmails: ['a@x.co'] }),
    });
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} onShared={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /Only people with these emails/ }));
    await user.type(screen.getByPlaceholderText(/name@company/), 'A@x.co, b@x.co');
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByText(/Only a@x.co, b@x.co can open this link/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('a@x.co is not verified yet');
    expect(api.createLink).toHaveBeenCalledWith(
      expect.objectContaining({ allowedEmails: ['a@x.co', 'b@x.co'] }),
    );
    await user.click(screen.getByRole('button', { name: /Email the link/ }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith(
        'share_compose_email',
        expect.objectContaining({
          to: ['a@x.co', 'b@x.co'],
          subject: 'I shared "GitHub" with you',
        }),
      ),
    );
  });

  it('shows an error when the email draft fails or the API rejects', async () => {
    mockCore({
      share_link_create: { id: ID, verifier: KEY, blob: blob('share-link'), url: 'http://s/#k' },
      share_compose_email: () => {
        throw new Error('no mail app');
      },
    });
    const user = userEvent.setup();
    const api = fakeApi();
    render(<ShareItem item={item} api={api} />);
    await user.click(screen.getByRole('radio', { name: /Only people/ }));
    await user.type(screen.getByPlaceholderText(/name@company/), 'a@x.co');
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    await user.click(await screen.findByRole('button', { name: /Email the link/ }));
    expect(await screen.findByText(/no mail app/)).toBeInTheDocument();
  });

  it('shows API errors when creating', async () => {
    linkCore();
    const api = fakeApi({ createLink: vi.fn().mockRejectedValue(new Error('quota')) });
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} />);
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota');
    expect(screen.getByRole('button', { name: /Create secure link/ })).toBeEnabled();
  });

  it('copies the link', async () => {
    linkCore();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<ShareItem item={item} api={fakeApi()} />);
    await user.click(screen.getByRole('button', { name: /Create secure link/ }));
    await screen.findByLabelText('Share link');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('http://share/#key');
  });
});

describe('ShareItem with a person', () => {
  const personCore = () =>
    mockCore({
      sharing_fingerprint: 'AB-CD-EF',
      sharing_identity: { publicKey: OTHER_KEY, fingerprint: 'me' },
      share_seal_to: {
        id: ID,
        senderPublicKey: OTHER_KEY,
        ephemeralPublicKey: KEY,
        blob: blob('share-box'),
      },
    });

  it('looks up, shows the security code and sends the share', async () => {
    personCore();
    const api = fakeApi();
    const onShared = vi.fn();
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} onShared={onShared} />);
    await user.click(screen.getByRole('radio', { name: 'A Zvault user' }));
    const find = screen.getByRole('button', { name: 'Find' });
    expect(find).toBeDisabled();
    await user.type(screen.getByLabelText('Their Zvault email'), 'bob@example.com');
    await user.click(find);
    expect(await screen.findByText('AB-CD-EF')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Share with bob@example.com' }));
    expect(await screen.findByText(/Shared with bob@example.com/)).toBeInTheDocument();
    expect(api.publishKey).toHaveBeenCalledWith(OTHER_KEY);
    expect(api.shareWithUser).toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmail: 'bob@example.com', recipientPublicKey: KEY }),
    );
    expect(onShared).toHaveBeenCalledWith('person');
    expect(localStorage.getItem('zvault.sharing.pins.v1')).toContain(KEY);
    await user.click(screen.getByRole('button', { name: 'Share with someone else' }));
    expect(screen.getByLabelText('Their Zvault email')).toHaveValue('');
  });

  it('warns when the recipient key changed since last time', async () => {
    personCore();
    localStorage.setItem(
      'zvault.sharing.pins.v1',
      JSON.stringify({ 'bob@example.com': OTHER_KEY }),
    );
    const user = userEvent.setup();
    render(<ShareItem item={item} api={fakeApi()} />);
    await user.click(screen.getByRole('radio', { name: 'A Zvault user' }));
    await user.type(screen.getByLabelText('Their Zvault email'), 'bob@example.com');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('different from the one');
  });

  it('shows lookup and send errors; editing the email clears the result', async () => {
    personCore();
    const api = fakeApi();
    (api.lookupKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no such user'));
    const user = userEvent.setup();
    render(<ShareItem item={item} api={api} />);
    await user.click(screen.getByRole('radio', { name: 'A Zvault user' }));
    const email = screen.getByLabelText('Their Zvault email');
    await user.type(email, 'bob@example.com');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no such user');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await screen.findByText('AB-CD-EF');
    await user.type(email, 'x');
    expect(screen.queryByText('AB-CD-EF')).not.toBeInTheDocument();

    (api.shareWithUser as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rejected'));
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await user.click(await screen.findByRole('button', { name: /Share with bob@example.com/ }));
    expect(await screen.findByText(/rejected/)).toBeInTheDocument();
  });
});

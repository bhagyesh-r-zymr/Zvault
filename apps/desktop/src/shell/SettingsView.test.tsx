import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../auth.js';
import type { LockStatus } from '../lock.js';
import { SettingsView, type SettingsSection } from './SettingsView.js';

const devicesProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock('../account/AccountSecurity.js', () => ({
  AccountSecurity: () => <div>account-security</div>,
}));
vi.mock('../LockSettingsPanel.js', () => ({
  LockSettingsPanel: (p: { onChanged: () => void }) => (
    <button type="button" onClick={p.onChanged}>
      lock-panel
    </button>
  ),
}));
vi.mock('../updates/UpdatePanel.js', () => ({ UpdatePanel: () => <div>update-panel</div> }));
vi.mock('../agents/CliSetup.js', () => ({
  CliInstall: () => <div>cli-install</div>,
  ClaudeSetup: () => <div>claude-setup</div>,
}));
vi.mock('../agents/SshAgentPanel.js', () => ({ SshAgentPanel: () => <div>ssh-panel</div> }));
vi.mock('../devices/DevicesPanel.js', () => ({
  DevicesPanel: (p: Record<string, unknown>) => {
    devicesProps.current = p;
    return <div>devices-panel</div>;
  },
}));
vi.mock('../two-factor/index.js', () => ({
  fetchTransport: vi.fn((_url: string, headers: () => Record<string, string>) => ({ headers })),
  twoFactorApi: vi.fn((t: unknown) => ({ transport: t })),
  TwoFactorSettings: (p: { account: string }) => <div>two-factor {p.account}</div>,
}));

const session: Session = {
  email: 'ada@example.com',
  token: 'tok',
  expiresAt: '2030-01-01T00:00:00Z',
};
const lockStatus = { locked: false } as LockStatus;

function setup(section: SettingsSection, over: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const props = {
    session,
    section,
    onSection: vi.fn(),
    lockStatus,
    onLockChanged: vi.fn(),
    remembered: null,
    onForgetSecretKey: vi.fn(() => Promise.resolve()),
    onSignOut: vi.fn(),
    ...over,
  };
  render(<SettingsView {...props} />);
  return props;
}

describe('SettingsView', () => {
  it('switches sections through the tabs', async () => {
    const user = userEvent.setup();
    const p = setup('security');
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    expect(p.onSection).toHaveBeenCalledWith('devices');
  });

  it('shows security panels and loads lock settings', async () => {
    const user = userEvent.setup();
    const p = setup('security');
    expect(screen.getByText('account-security')).toBeInTheDocument();
    expect(screen.getByText('two-factor ada@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'lock-panel' }));
    expect(p.onLockChanged).toHaveBeenCalled();
  });

  it('shows a placeholder while lock status is loading', () => {
    setup('security', { lockStatus: null });
    expect(screen.getByText('Loading lock settings…')).toBeInTheDocument();
  });

  it('wires the devices panel to the API and sign-out', () => {
    const p = setup('devices');
    expect(screen.getByText('devices-panel')).toBeInTheDocument();
    expect(devicesProps.current).toMatchObject({ onSignedOut: p.onSignOut });
    expect(typeof devicesProps.current!.apiUrl).toBe('string');
  });

  it('shows command line and ssh sections', () => {
    setup('cli');
    expect(screen.getByText('cli-install')).toBeInTheDocument();
    expect(screen.getByText('claude-setup')).toBeInTheDocument();
  });

  it('shows the ssh agent panel', () => {
    setup('ssh');
    expect(screen.getByText('ssh-panel')).toBeInTheDocument();
  });

  it('shows the account with sign out and updates', async () => {
    const user = userEvent.setup();
    const p = setup('account');
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('update-panel')).toBeInTheDocument();
    expect(screen.getByText(/Not saved on this Mac/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(p.onSignOut).toHaveBeenCalled();
  });

  it('lets the person forget a saved Secret Key', async () => {
    const user = userEvent.setup();
    const p = setup('account', { remembered: { email: 'ada@example.com', secretKeyId: 'ABC123' } });
    expect(screen.getByText(/saved in/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Forget/ }));
    await waitFor(() => expect(p.onForgetSecretKey).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /Forget/ })).toBeEnabled());
  });

  it('shows why forgetting failed', async () => {
    const user = userEvent.setup();
    setup('account', {
      remembered: { email: 'ada@example.com', secretKeyId: 'ABC123' },
      onForgetSecretKey: () => Promise.reject(new Error('keychain locked')),
    });
    await user.click(screen.getByRole('button', { name: /Forget/ }));
    expect(await screen.findByText(/keychain locked/)).toBeInTheDocument();
  });

  it('ignores a remembered key belonging to another account', () => {
    setup('account', { remembered: { email: 'other@example.com', secretKeyId: 'ZZZ' } });
    expect(screen.getByText(/Not saved on this Mac/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Forget/ })).not.toBeInTheDocument();
  });
});

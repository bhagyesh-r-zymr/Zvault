import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { recoveryStatus: vi.fn() } }));
vi.mock('../auth.js', async (orig) => ({
  ...(await orig<typeof import('../auth.js')>()),
  changeMasterPassword: vi.fn(),
  setUpRecovery: vi.fn(),
}));
vi.mock('../core.js', () => ({
  core: { saveRecoveryKit: vi.fn(), discardRecoveryCode: vi.fn(() => Promise.resolve()) },
}));

const { api } = await import('../api.js');
const { changeMasterPassword, setUpRecovery } = await import('../auth.js');
const { core } = await import('../core.js');
const { AccountSecurity } = await import('./AccountSecurity.js');
const { RecoveryCodeCard } = await import('./RecoveryCodeCard.js');

const session = { email: 'a@b.co', token: 'tok', expiresAt: 'x' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(core.discardRecoveryCode).mockResolvedValue(undefined);
});

describe('RecoveryCodeCard', () => {
  it('shows the code and saves the kit PDF', async () => {
    vi.mocked(core.saveRecoveryKit).mockResolvedValue(true);
    const onSaved = vi.fn();
    render(<RecoveryCodeCard code="R1-CODE" onSaved={onSaved} />);
    expect(screen.getByLabelText('Recovery code')).toHaveTextContent('R1-CODE');
    await userEvent.click(screen.getByRole('button', { name: 'Save Recovery Kit PDF' }));
    expect(await screen.findByRole('button', { name: 'Save another copy' })).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it('ignores a cancelled dialog and shows failures', async () => {
    vi.mocked(core.saveRecoveryKit)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('disk'));
    render(<RecoveryCodeCard code="R1" label="Custom label" />);
    expect(screen.getByText('Custom label')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save Recovery Kit PDF' }));
    expect(screen.getByRole('button', { name: 'Save Recovery Kit PDF' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save Recovery Kit PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk');
  });
});

describe('AccountSecurity', () => {
  const status = (enabled: boolean, updatedAt: string | null = null) =>
    vi.mocked(api.recoveryStatus).mockResolvedValue({ enabled, updatedAt });

  it('shows a recovery status error', async () => {
    vi.mocked(api.recoveryStatus).mockRejectedValue(new Error('offline'));
    render(<AccountSecurity session={session} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled();
  });

  it('prompts to set up a missing recovery code', async () => {
    status(false);
    render(<AccountSecurity session={session} />);
    expect(await screen.findByText('No recovery code yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toHaveClass('primary');
  });

  it('changes the master password', async () => {
    status(true, '2026-03-04T00:00:00.000Z');
    vi.mocked(changeMasterPassword).mockResolvedValue(undefined);
    render(<AccountSecurity session={session} />);
    expect(await screen.findByText('Recovery code is set up')).toBeInTheDocument();
    expect(screen.getByText(/Made /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText('Current master password'),
      'old password 1',
    );
    await userEvent.type(within(dialog).getByLabelText('New master password'), 'new password 22');
    await userEvent.type(
      within(dialog).getByLabelText('Confirm new master password'),
      'new password 22',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    expect(changeMasterPassword).toHaveBeenCalledWith(session, 'old password 1', 'new password 22');
    expect(await screen.findByText(/Changed\. Your other devices/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('validates the new password and surfaces server failures', async () => {
    status(true);
    vi.mocked(changeMasterPassword).mockRejectedValue(new Error('Wrong current password'));
    render(<AccountSecurity session={session} />);
    await screen.findByText('Recovery code is set up');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    const cur = within(dialog).getByLabelText('Current master password');
    const next = within(dialog).getByLabelText('New master password');
    const conf = within(dialog).getByLabelText('Confirm new master password');
    const go = within(dialog).getByRole('button', { name: 'Change password' });

    await userEvent.type(cur, 'same password 1');
    await userEvent.type(next, 'short');
    await userEvent.type(conf, 'short');
    await userEvent.click(go);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/at least 10/);

    await userEvent.clear(next);
    await userEvent.clear(conf);
    await userEvent.type(next, 'same password 1');
    await userEvent.type(conf, 'same password 1');
    await userEvent.click(go);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/different from the current/);
    expect(changeMasterPassword).not.toHaveBeenCalled();

    await userEvent.clear(next);
    await userEvent.clear(conf);
    await userEvent.type(next, 'another password 2');
    await userEvent.type(conf, 'another password 2');
    await userEvent.click(go);
    expect(await within(dialog).findByText('Wrong current password')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('makes a recovery code, then requires confirmation to close', async () => {
    status(false);
    vi.mocked(setUpRecovery).mockResolvedValue('R1-NEWCODE');
    render(<AccountSecurity session={session} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    const dialog = screen.getByRole('dialog', { name: 'Set up a recovery code' });
    await userEvent.type(within(dialog).getByLabelText('Master password'), 'my password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make recovery code' }));
    expect(setUpRecovery).toHaveBeenCalledWith(session, 'my password');
    expect(await within(dialog).findByText('R1-NEWCODE')).toBeInTheDocument();
    const done = within(dialog).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(done);
    expect(core.discardRecoveryCode).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.recoveryStatus).toHaveBeenCalledTimes(2);
  });

  it('replaces an existing code and reports failures', async () => {
    status(true);
    vi.mocked(setUpRecovery).mockRejectedValue(new Error('bad password'));
    render(<AccountSecurity session={session} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace recovery code' });
    expect(within(dialog).getByText(/current recovery code stops working/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Master password'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace code' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('bad password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(core.discardRecoveryCode).toHaveBeenCalled();
  });
});

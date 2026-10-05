import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { recoverStart: vi.fn() } }));
vi.mock('../auth.js', async (orig) => ({
  ...(await orig<typeof import('../auth.js')>()),
  verifyRecovery: vi.fn(),
  prepareRecovery: vi.fn(),
  finishRecovery: vi.fn(),
}));
vi.mock('../core.js', () => ({
  core: {
    saveEmergencyKit: vi.fn(),
    discardEmergencyKit: vi.fn(),
    discardRecoveryCode: vi.fn(),
    saveRecoveryKit: vi.fn(),
  },
}));

const { api } = await import('../api.js');
const { verifyRecovery, prepareRecovery, finishRecovery } = await import('../auth.js');
const { core } = await import('../core.js');
const { RecoverCodes, RecoveredKits, RecoverEmail, RecoverPassword } = await import('./Recover.js');

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('RecoverEmail', () => {
  it('emails a code and moves on', async () => {
    vi.mocked(api.recoverStart).mockResolvedValue(undefined);
    const onSent = vi.fn();
    const onBack = vi.fn();
    render(<RecoverEmail email="x@b.co" onSent={onSent} onBack={onBack} />);
    const field = screen.getByLabelText('Email');
    expect(field).toHaveValue('x@b.co');
    await userEvent.clear(field);
    await userEvent.type(field, ' Y@B.co ');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(api.recoverStart).toHaveBeenCalledWith('y@b.co');
    expect(onSent).toHaveBeenCalledWith('y@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('starts empty and shows errors', async () => {
    vi.mocked(api.recoverStart).mockRejectedValue(new Error('nope'));
    render(<RecoverEmail onSent={vi.fn()} onBack={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});

describe('RecoverCodes', () => {
  it('verifies the email and recovery codes', async () => {
    const verified = {
      email: 'a@b.co',
      recoveryToken: 'rt',
      recoveryKeyset: {},
      twoFactorRequired: false,
    };
    vi.mocked(verifyRecovery).mockResolvedValue(verified as never);
    const onVerified = vi.fn();
    const onBack = vi.fn();
    render(<RecoverCodes email="a@b.co" onVerified={onVerified} onBack={onBack} />);
    await userEvent.type(screen.getByLabelText('Code from your email'), '123 456');
    await userEvent.type(screen.getByLabelText('Recovery code'), 'R1-ABC');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(verifyRecovery).toHaveBeenCalledWith('a@b.co', '123456', 'R1-ABC');
    expect(onVerified).toHaveBeenCalledWith(verified);
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows verification errors', async () => {
    vi.mocked(verifyRecovery).mockRejectedValue(new Error('bad codes'));
    render(<RecoverCodes email="a@b.co" onVerified={vi.fn()} onBack={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Code from your email'), '1');
    await userEvent.type(screen.getByLabelText('Recovery code'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad codes');
  });

  it('allows a resend after the countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.recoverStart).mockResolvedValue(undefined);
    render(<RecoverCodes email="a@b.co" onVerified={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Resend code in/ })).toBeDisabled();
    for (let i = 0; i < 60; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
    await userEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(api.recoverStart).toHaveBeenCalledWith('a@b.co');
  });
});

describe('RecoverPassword', () => {
  const verified = (twoFactorRequired: boolean) =>
    ({ email: 'a@b.co', recoveryToken: 'rt', recoveryKeyset: {}, twoFactorRequired }) as never;
  const account = { secretKeyId: 'K' } as never;
  const result = {
    session: { email: 'a@b.co', token: 't', expiresAt: 'x' },
    recoveryCode: 'R1-NEW',
  };

  const fill = async (pw = 'long enough pw', confirm = pw) => {
    await userEvent.type(screen.getByLabelText('New master password'), pw);
    await userEvent.type(screen.getByLabelText('Confirm new master password'), confirm);
  };
  const submit = () => userEvent.click(screen.getByRole('button', { name: 'Reset and unlock' }));

  it('rejects a bad password', async () => {
    render(<RecoverPassword verified={verified(false)} onRecovered={vi.fn()} onBack={vi.fn()} />);
    await fill('short');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10/);
    expect(prepareRecovery).not.toHaveBeenCalled();
  });

  it('prepares keys and finishes without 2FA', async () => {
    vi.mocked(prepareRecovery).mockResolvedValue(account);
    vi.mocked(finishRecovery).mockResolvedValue(result);
    const onRecovered = vi.fn();
    const onBack = vi.fn();
    render(
      <RecoverPassword verified={verified(false)} onRecovered={onRecovered} onBack={onBack} />,
    );
    expect(screen.queryByLabelText('Two-step sign-in code')).toBeNull();
    await fill();
    await submit();
    expect(finishRecovery).toHaveBeenCalledWith(expect.anything(), account, undefined);
    expect(onRecovered).toHaveBeenCalledWith(result);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('requires a 2FA code and accepts a code or a recovery code', async () => {
    vi.mocked(prepareRecovery).mockResolvedValue(account);
    vi.mocked(finishRecovery).mockResolvedValue(result);
    render(<RecoverPassword verified={verified(true)} onRecovered={vi.fn()} onBack={vi.fn()} />);
    await fill();
    const tf = screen.getByLabelText('Two-step sign-in code');
    await userEvent.type(tf, '12');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/6-digit code/);
    expect(finishRecovery).not.toHaveBeenCalled();
    await userEvent.clear(tf);
    await userEvent.type(tf, '123 456');
    await submit();
    expect(finishRecovery).toHaveBeenLastCalledWith(expect.anything(), account, { code: '123456' });
    await userEvent.clear(tf);
    await userEvent.type(tf, 'abcd0-efgh0');
    await submit();
    expect(finishRecovery).toHaveBeenLastCalledWith(expect.anything(), account, {
      recoveryCode: 'ABCD0-EFGH0',
    });
  });

  it('reuses prepared keys when the upload is retried with the same password', async () => {
    vi.mocked(prepareRecovery).mockResolvedValue(account);
    vi.mocked(finishRecovery)
      .mockRejectedValueOnce(new Error('wrong 2fa'))
      .mockResolvedValue(result);
    const onRecovered = vi.fn();
    render(
      <RecoverPassword verified={verified(false)} onRecovered={onRecovered} onBack={vi.fn()} />,
    );
    await fill();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong 2fa');
    await submit();
    expect(prepareRecovery).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith(result);
  });
});

describe('RecoveredKits', () => {
  const setup = () => {
    const onDone = vi.fn();
    render(<RecoveredKits email="a@b.co" recoveryCode="R1-CODE" onDone={onDone} />);
    return onDone;
  };

  it('requires a saved kit and confirmation before opening the vault', async () => {
    vi.mocked(core.saveEmergencyKit).mockResolvedValue(true);
    vi.mocked(core.discardEmergencyKit).mockResolvedValue(undefined);
    vi.mocked(core.discardRecoveryCode).mockResolvedValue(undefined);
    const onDone = setup();
    const open = screen.getByRole('button', { name: 'Open my vault' });
    expect(open).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Kit PDF' }));
    expect(await screen.findByRole('button', { name: 'Save another copy' })).toBeInTheDocument();
    expect(open).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(open);
    expect(core.discardEmergencyKit).toHaveBeenCalled();
    expect(core.discardRecoveryCode).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('stays unsaved when the save dialog is cancelled and shows errors', async () => {
    vi.mocked(core.saveEmergencyKit)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce('disk full');
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Kit PDF' }));
    expect(screen.getByRole('button', { name: 'Save Emergency Kit PDF' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Kit PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  });

  it('still finishes if discarding fails', async () => {
    vi.mocked(core.saveEmergencyKit).mockResolvedValue(true);
    vi.mocked(core.discardEmergencyKit).mockRejectedValue(new Error('x'));
    vi.mocked(core.discardRecoveryCode).mockResolvedValue(undefined);
    const onDone = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Kit PDF' }));
    await screen.findByRole('button', { name: 'Save another copy' });
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Open my vault' }));
    expect(onDone).toHaveBeenCalled();
  });
});

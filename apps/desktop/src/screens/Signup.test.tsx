import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  api: { signupStart: vi.fn(), signupVerify: vi.fn(), recoverStart: vi.fn() },
}));
vi.mock('../auth.js', async (orig) => ({
  ...(await orig<typeof import('../auth.js')>()),
  createAccount: vi.fn(),
}));

const { api } = await import('../api.js');
const { createAccount } = await import('../auth.js');
const { SignupCode, SignupEmail, SignupPassword } = await import('./Signup.js');

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('SignupEmail', () => {
  it('sends a code to the normalized email', async () => {
    vi.mocked(api.signupStart).mockResolvedValue(undefined);
    const onSent = vi.fn();
    const onSignIn = vi.fn();
    render(<SignupEmail onSent={onSent} onSignIn={onSignIn} />);
    await userEvent.type(screen.getByLabelText('Email'), ' New@B.co ');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(api.signupStart).toHaveBeenCalledWith('new@b.co');
    expect(onSent).toHaveBeenCalledWith('new@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it('shows the server error', async () => {
    vi.mocked(api.signupStart).mockRejectedValue(new Error('Too many'));
    render(<SignupEmail onSent={vi.fn()} onSignIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many');
  });
});

describe('SignupCode', () => {
  it('verifies digits only', async () => {
    vi.mocked(api.signupVerify).mockResolvedValue({ signupToken: 'tok' } as never);
    const onVerified = vi.fn();
    const onBack = vi.fn();
    render(<SignupCode email="a@b.co" onVerified={onVerified} onBack={onBack} />);
    await userEvent.type(screen.getByLabelText('Verification code'), '123 456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(api.signupVerify).toHaveBeenCalledWith('a@b.co', '123456');
    expect(onVerified).toHaveBeenCalledWith('tok');
    await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('counts down before allowing a resend', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.signupStart).mockResolvedValue(undefined);
    render(<SignupCode email="a@b.co" onVerified={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Resend code in 60s' })).toBeDisabled();
    for (let i = 0; i < 60; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
    const resend = screen.getByRole('button', { name: 'Resend code' });
    expect(resend).toBeEnabled();
    await userEvent.click(resend);
    expect(api.signupStart).toHaveBeenCalledWith('a@b.co');
    expect(screen.getByRole('button', { name: 'Resend code in 60s' })).toBeDisabled();
  });
});

describe('SignupPassword', () => {
  const setup = () => {
    const onCreated = vi.fn();
    render(<SignupPassword email="a@b.co" signupToken="st" onCreated={onCreated} />);
    return onCreated;
  };
  const type = async (pw: string, confirm: string) => {
    await userEvent.type(screen.getByLabelText('Master password'), pw);
    await userEvent.type(screen.getByLabelText('Confirm master password'), confirm);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  };

  it('rejects weak or mismatched passwords before touching the core', async () => {
    const onCreated = setup();
    await type('short', 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10/);
    expect(createAccount).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('reports a mismatch', async () => {
    setup();
    await type('long enough pw', 'long enough px');
    expect(await screen.findByRole('alert')).toHaveTextContent(/don't match/);
  });

  it('creates the account and hands over the Secret Key', async () => {
    vi.mocked(createAccount).mockResolvedValue('Z1-SECRET');
    const onCreated = setup();
    await type('long enough pw', 'long enough pw');
    expect(createAccount).toHaveBeenCalledWith('a@b.co', 'long enough pw', 'st');
    expect(onCreated).toHaveBeenCalledWith('Z1-SECRET');
  });
});

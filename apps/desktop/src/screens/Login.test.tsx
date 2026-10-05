import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth.js', async (orig) => ({
  ...(await orig<typeof import('../auth.js')>()),
  signIn: vi.fn(),
}));
vi.mock('../core.js', async (orig) => {
  const real = await orig<typeof import('../core.js')>();
  return {
    ...real,
    core: { importEmergencyKit: vi.fn(), clearEmergencyKitImport: vi.fn(() => Promise.resolve()) },
  };
});

const { signIn } = await import('../auth.js');
const { core } = await import('../core.js');
const { ApiRequestError } = await import('../api.js');
const { Login } = await import('./Login.js');

const session = { email: 'a@b.co', token: 't', expiresAt: 'x' };
const noop = () => undefined;

function setup(props: Partial<Parameters<typeof Login>[0]> = {}) {
  const handlers = { onSignedIn: vi.fn(), onCreateAccount: vi.fn(), onForgotPassword: vi.fn() };
  render(<Login {...handlers} {...props} />);
  return handlers;
}

beforeEach(() => vi.resetAllMocks());

describe('Login', () => {
  it('signs in with a typed secret key', async () => {
    vi.mocked(signIn).mockResolvedValue(session);
    const h = setup();
    expect(screen.getByRole('heading', { name: 'Sign in to Zvault' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), ' A@B.co ');
    await userEvent.type(screen.getByLabelText('Secret Key'), 'Z1-KEY');
    await userEvent.type(screen.getByLabelText('Master password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith('a@b.co', 'pw', 'Z1-KEY');
    expect(h.onSignedIn).toHaveBeenCalledWith(session);
  });

  it('shows sign-in errors', async () => {
    vi.mocked(signIn).mockRejectedValue(new Error('Wrong password'));
    setup();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Secret Key'), 'k');
    await userEvent.type(screen.getByLabelText('Master password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
  });

  it('uses the remembered key for that account and lets the person type another', async () => {
    vi.mocked(signIn).mockResolvedValue(session);
    const h = setup({ email: 'a@b.co', remembered: { email: 'a@b.co', secretKeyId: 'ABC123' } });
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Z1-ABC123-•••••-•••••-•••••-•••••-•••••')).toBeInTheDocument();
    expect(screen.getByText('Saved in this Mac’s Keychain.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Master password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith('a@b.co', 'pw', null);
    expect(h.onSignedIn).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Use a different key' }));
    expect(screen.getByLabelText('Secret Key')).toBeInTheDocument();
  });

  it('reads the key from an Emergency Kit and fills the email', async () => {
    vi.mocked(core.importEmergencyKit).mockResolvedValue({
      email: 'kit@b.co',
      secretKeyId: 'KIT999',
    });
    vi.mocked(signIn).mockResolvedValue(session);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Choose your Emergency Kit PDF' }));
    expect(await screen.findByText(/Z1-KIT999/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('kit@b.co');
    expect(screen.getByText(/Read from your Emergency Kit/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Master password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith('kit@b.co', 'pw', null);
    await userEvent.click(screen.getByRole('button', { name: 'Type it instead' }));
    expect(core.clearEmergencyKitImport).toHaveBeenCalled();
    expect(screen.getByLabelText('Secret Key')).toBeInTheDocument();
  });

  it('notes a kit that belongs to a different email, ignores a cancelled pick, shows pick errors', async () => {
    vi.mocked(core.importEmergencyKit)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('not a kit'))
      .mockResolvedValueOnce({ email: 'other@b.co', secretKeyId: 'K1' });
    setup();
    await userEvent.type(screen.getByLabelText('Email'), 'me@b.co');
    const choose = () => screen.getByRole('button', { name: 'Choose your Emergency Kit PDF' });
    await userEvent.click(choose());
    expect(screen.getByLabelText('Secret Key')).toBeInTheDocument();
    await userEvent.click(choose());
    expect(await screen.findByRole('alert')).toHaveTextContent('not a kit');
    await userEvent.click(choose());
    expect(
      await screen.findByText('Read from the Emergency Kit for other@b.co.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('me@b.co');
  });

  it('hides the kit picker when a key was typed during sign-up', () => {
    setup({ email: 'a@b.co', secretKey: 'Z1-NEW' });
    expect(screen.queryByRole('button', { name: /Emergency Kit PDF/ })).toBeNull();
    expect(screen.getByLabelText('Secret Key')).toHaveValue('Z1-NEW');
  });

  it('offers account creation and password recovery', async () => {
    const h = setup();
    await userEvent.type(screen.getByLabelText('Email'), ' Me@B.co');
    await userEvent.click(screen.getByRole('button', { name: 'Forgot master password?' }));
    expect(h.onForgotPassword).toHaveBeenCalledWith('me@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(h.onCreateAccount).toHaveBeenCalled();
  });

  describe('two-factor', () => {
    const fill = async () => {
      await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
      await userEvent.type(screen.getByLabelText('Secret Key'), 'k');
      await userEvent.type(screen.getByLabelText('Master password'), 'pw');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    };

    it('completes the challenge with a code', async () => {
      const complete = vi.fn().mockResolvedValue(session);
      vi.mocked(signIn).mockResolvedValue({ twoFactor: true, expiresAt: 'x', complete });
      const h = setup();
      await fill();
      await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(complete).toHaveBeenCalledWith({ code: '123456' });
      expect(h.onSignedIn).toHaveBeenCalledWith(session);
    });

    it('maps API errors to a described message, and cancel returns to the form', async () => {
      const complete = vi
        .fn()
        .mockRejectedValue(new ApiRequestError(400, 'bad', 'invalid_two_factor_code'));
      vi.mocked(signIn).mockResolvedValue({ twoFactor: true, expiresAt: 'x', complete });
      setup();
      await fill();
      await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByLabelText('Master password')).toHaveValue('');
    });

    it('passes non-API errors through', async () => {
      const complete = vi.fn().mockRejectedValue(new Error('x'));
      vi.mocked(signIn).mockResolvedValue({ twoFactor: true, expiresAt: 'x', complete });
      setup();
      await fill();
      await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t reach/);
    });
  });

  it('is used with no handlers beyond the required ones', () => {
    render(<Login onSignedIn={noop} onCreateAccount={noop} onForgotPassword={noop} />);
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test/tauri.js';
import { ApiError, describeError, fetchTransport, twoFactorApi, type TwoFactorApi } from './api.js';
import { RecoveryCodes } from './RecoveryCodes.js';
import { TwoFactorPrompt } from './TwoFactorPrompt.js';
import { TwoFactorSettings } from './TwoFactorSettings.js';
import { TwoFactorSetup } from './TwoFactorSetup.js';

afterEach(() => vi.unstubAllGlobals());

const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${i}-EFGH${i}`);
const setup = {
  otpauthUri: 'otpauth://totp/Zvault:a@b.co?secret=JBSWY3DPEHPK3PXP',
  secret: 'JBSWY3DPEHPK3PXP',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

function fakeApi(over: Partial<Record<keyof TwoFactorApi, unknown>> = {}) {
  return {
    status: vi
      .fn()
      .mockResolvedValue({ totpEnabled: false, recoveryCodesRemaining: 0, enabledAt: null }),
    beginSetup: vi.fn().mockResolvedValue(setup),
    confirmSetup: vi.fn().mockResolvedValue({ recoveryCodes: CODES }),
    regenerateRecoveryCodes: vi.fn().mockResolvedValue({ recoveryCodes: CODES }),
    disable: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as TwoFactorApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe('api', () => {
  it('sends JSON with auth headers and parses the reply', async () => {
    const spy = mockFetch({
      'GET /v1/2fa': { totpEnabled: true, recoveryCodesRemaining: 4, enabledAt: null },
      'POST /v1/2fa/disable': () => new Response(null, { status: 204 }),
      'POST /v1/2fa/totp/setup': setup,
      'POST /v1/2fa/totp/confirm': { recoveryCodes: CODES },
      'POST /v1/2fa/recovery-codes': { recoveryCodes: CODES },
    });
    const api = twoFactorApi(fetchTransport('http://x', () => ({ authorization: 'Bearer t' })));
    expect((await api.status()).recoveryCodesRemaining).toBe(4);
    expect((await api.beginSetup()).secret).toBe(setup.secret);
    expect((await api.confirmSetup('123456')).recoveryCodes).toHaveLength(10);
    expect((await api.regenerateRecoveryCodes({ code: '123456' })).recoveryCodes).toHaveLength(10);
    await expect(api.disable({ code: '123456' })).resolves.toBeUndefined();
    const init = spy.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(init.body).toBeNull();
  });

  it('rejects with ApiError carrying status and code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_two_factor_code', message: 'Nope' }), {
          status: 400,
        }),
      ),
    );
    const t = fetchTransport('http://x', () => ({}));
    await expect(t('POST', '/2fa/x', {})).rejects.toMatchObject({
      status: 400,
      code: 'invalid_two_factor_code',
      message: 'Nope',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x', { status: 500, statusText: 'Bad' })),
    );
    await expect(t('GET', '/2fa')).rejects.toMatchObject({ status: 500, message: 'Bad' });
  });

  it('describes errors for people', () => {
    expect(describeError(new ApiError(400, 'invalid_two_factor_code', 'm'))).toMatch(/didn’t work/);
    expect(describeError(new ApiError(429, 'two_factor_locked', 'm'))).toMatch(/15 minutes/);
    expect(describeError(new ApiError(400, 'two_factor_setup_not_started', 'm'))).toMatch(
      /expired/,
    );
    expect(describeError(new ApiError(401, undefined, 'm'))).toMatch(/session has ended/);
    expect(describeError(new ApiError(500, undefined, 'server said so'))).toBe('server said so');
    expect(describeError(new Error('x'))).toMatch(/Couldn’t reach/);
  });
});

describe('RecoveryCodes', () => {
  it('lists the codes and needs confirmation before Done', async () => {
    const onDone = vi.fn();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<RecoveryCodes codes={CODES} account="a@b.co" onDone={onDone} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(done);
    expect(onDone).toHaveBeenCalled();
  });

  it('does not claim copied when the clipboard fails, and downloads a file', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('x')) } });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<RecoveryCodes codes={CODES} account="a@b.co" onDone={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.queryByText('Copied')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(click.mock.calls).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
  });
});

describe('TwoFactorPrompt', () => {
  it('submits a 6-digit code', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TwoFactorPrompt onSubmit={onSubmit} onCancel={() => undefined} />);
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('6-digit code'), '123 456');
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ code: '123456' });
  });

  it('switches to a recovery code and back', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TwoFactorPrompt onSubmit={onSubmit} onCancel={() => undefined} title="Custom" />);
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await userEvent.type(screen.getByLabelText('Recovery code'), 'abcd0-efgh0');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSubmit).toHaveBeenCalledWith({ recoveryCode: 'ABCD0-EFGH0' });
    await userEvent.click(screen.getByRole('button', { name: 'Use your authenticator app' }));
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
  });

  it('shows a described error and clears the field', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_two_factor_code', 'm'));
    render(<TwoFactorPrompt onSubmit={onSubmit} onCancel={() => undefined} />);
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/didn’t work/);
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
  });

  it('ignores a submit with an incomplete code and can cancel', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<TwoFactorPrompt onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.type(screen.getByLabelText('6-digit code'), '12{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('TwoFactorSetup', () => {
  it('walks intro, QR, confirmation and recovery codes', async () => {
    const api = fakeApi();
    const onEnabled = vi.fn();
    render(
      <TwoFactorSetup
        api={api}
        account="a@b.co"
        onEnabled={onEnabled}
        onCancel={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByAltText(/QR code/)).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml'),
    );
    await userEvent.click(screen.getByRole('button', { name: /Enter a key instead/ }));
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    const turnOn = screen.getByRole('button', { name: 'Turn on' });
    expect(turnOn).toBeDisabled();
    await userEvent.type(screen.getByLabelText('6-digit code'), '654321');
    await userEvent.click(turnOn);
    expect(api.confirmSetup).toHaveBeenCalledWith('654321');
    expect(await screen.findByText('Save your recovery codes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onEnabled).toHaveBeenCalled();
  });

  it('shows start failures and wrong-code errors', async () => {
    const api = fakeApi({
      beginSetup: vi.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValue(setup),
      confirmSetup: vi.fn().mockRejectedValue(new ApiError(400, 'invalid_two_factor_code', 'm')),
    });
    const onCancel = vi.fn();
    render(
      <TwoFactorSetup api={api} account="a" onEnabled={() => undefined} onCancel={onCancel} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t reach/);
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await screen.findByAltText(/QR code/);
    await userEvent.type(screen.getByLabelText('6-digit code'), '111111');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/didn’t work/);
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('ignores a submit of a recovery-code-shaped value', async () => {
    const api = fakeApi();
    render(
      <TwoFactorSetup
        api={api}
        account="a"
        onEnabled={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await screen.findByAltText(/QR code/);
    await userEvent.type(screen.getByLabelText('6-digit code'), '12{Enter}');
    expect(api.confirmSetup).not.toHaveBeenCalled();
  });
});

describe('TwoFactorSettings', () => {
  it('offers to turn on when off', async () => {
    const api = fakeApi();
    render(<TwoFactorSettings api={api} account="a@b.co" />);
    expect(await screen.findByText('Two-step sign-in is off')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(screen.getByText('Turn on two-factor authentication')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Two-step sign-in is off')).toBeInTheDocument();
  });

  const on = (n: number) =>
    vi.fn().mockResolvedValue({
      totpEnabled: true,
      recoveryCodesRemaining: n,
      enabledAt: '2026-01-02T00:00:00.000Z',
    });

  it('shows status and warns when few codes remain', async () => {
    render(<TwoFactorSettings api={fakeApi({ status: on(2) })} account="a" />);
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
    expect(
      screen.getByText(/2 of 10 recovery codes left\. Get a new set soon\./),
    ).toBeInTheDocument();
  });

  it('turns off after proving a code', async () => {
    const api = fakeApi({ status: on(8) });
    render(<TwoFactorSettings api={api} account="a" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(
      screen.getByRole('heading', { name: 'Turn off two-factor authentication' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.disable).toHaveBeenCalledWith({ code: '123456' });
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
  });

  it('regenerates recovery codes and shows them', async () => {
    const api = fakeApi({ status: on(8) });
    render(<TwoFactorSettings api={api} account="a" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Recovery codes' }));
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Save your recovery codes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
  });

  it('cancels a confirmation and shows a status error', async () => {
    const api = fakeApi({ status: on(8) });
    const { unmount } = render(<TwoFactorSettings api={api} account="a" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
    unmount();
    render(
      <TwoFactorSettings
        api={fakeApi({ status: vi.fn().mockRejectedValue(new Error('x')) })}
        account="a"
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t reach/);
  });
});

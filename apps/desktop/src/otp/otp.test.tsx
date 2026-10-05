import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { otpCore, type OtpCore, type OtpSetup } from './core.js';
import { OneTimePasswordCode } from './OneTimePasswordCode.js';
import { OneTimePasswordEditor } from './OneTimePasswordEditor.js';

const URI = 'otpauth://totp/GitHub:me?secret=ABC&issuer=GitHub';
const setup: OtpSetup = {
  uri: URI,
  issuer: 'GitHub',
  account: 'me',
  current: { code: '123456', period: 30, remaining: 20 },
};

afterEach(() => vi.useRealTimers());

describe('otpCore', () => {
  it('calls the matching commands', async () => {
    const calls = mockCore({
      otp_parse: setup,
      otp_code: setup.current,
      otp_scan_screen: null,
      otp_scan_image: null,
    });
    expect(await otpCore.parse('x')).toEqual(setup);
    expect(await otpCore.code(URI)).toEqual(setup.current);
    expect(await otpCore.scanScreen()).toBeNull();
    expect(await otpCore.scanImage()).toBeNull();
    expect(calls).toHaveBeenCalledWith('otp_parse', { input: 'x' });
    expect(calls).toHaveBeenCalledWith('otp_code', { uri: URI });
  });
});

describe('OneTimePasswordCode', () => {
  it('shows a formatted code, counts down and refetches when expired', async () => {
    vi.useFakeTimers();
    const getCode = vi
      .fn()
      .mockResolvedValueOnce({ code: '123456', period: 30, remaining: 2 })
      .mockResolvedValue({ code: '654321', period: 30, remaining: 30 });
    render(<OneTimePasswordCode getCode={getCode} />);
    await act(() => Promise.resolve());
    expect(screen.getByLabelText('One-time password')).toHaveTextContent('123 456');
    expect(screen.getByRole('img', { name: '2 seconds left' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    await act(() => Promise.resolve());
    expect(screen.getByLabelText('One-time password')).toHaveTextContent('654 321');
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it('copies the code and shows confirmation', async () => {
    const copy = vi.fn().mockResolvedValue(30);
    const user = userEvent.setup();
    render(<OneTimePasswordCode getCode={() => Promise.resolve(setup.current)} copy={copy} />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('123456');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports copy and fetch errors; renders nothing without a code', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <OneTimePasswordCode
        getCode={() => Promise.resolve(setup.current)}
        copy={() => Promise.reject(new Error('denied'))}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('denied');
    unmount();

    const { container, unmount: u2 } = render(
      <OneTimePasswordCode getCode={() => Promise.resolve(null)} />,
    );
    await act(() => Promise.resolve());
    expect(container).toBeEmptyDOMElement();
    u2();

    render(<OneTimePasswordCode getCode={() => Promise.reject(new Error('nope'))} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});

function fakeCore(over: Partial<OtpCore> = {}): OtpCore {
  return {
    parse: vi.fn().mockResolvedValue(setup),
    code: vi.fn().mockResolvedValue(setup.current),
    scanScreen: vi.fn().mockResolvedValue(setup),
    scanImage: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

describe('OneTimePasswordEditor', () => {
  it('adds a pasted key and reports the URI', async () => {
    const onChange = vi.fn();
    const core = fakeCore();
    const user = userEvent.setup();
    render(<OneTimePasswordEditor value="" onChange={onChange} core={core} />);
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Setup key or otpauth link'), 'JBSWY3DP');
    await user.click(add);
    expect(core.parse).toHaveBeenCalledWith('JBSWY3DP');
    expect(onChange).toHaveBeenCalledWith(URI);
  });

  it('scans the screen, ignoring a cancelled image pick', async () => {
    const onChange = vi.fn();
    const core = fakeCore();
    const user = userEvent.setup();
    render(<OneTimePasswordEditor value="" onChange={onChange} core={core} />);
    await user.click(screen.getByRole('button', { name: /Choose QR image/ }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Scan QR code on screen/ }));
    expect(onChange).toHaveBeenCalledWith(URI);
  });

  it('shows errors from a failed parse', async () => {
    const core = fakeCore({ parse: vi.fn().mockRejectedValue(new Error('bad key')) });
    const user = userEvent.setup();
    render(<OneTimePasswordEditor value="" onChange={vi.fn()} core={core} />);
    await user.type(screen.getByLabelText('Setup key or otpauth link'), 'zzz');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad key');
  });

  it('describes an existing value and removes it', async () => {
    const onChange = vi.fn();
    const core = fakeCore();
    const user = userEvent.setup();
    render(<OneTimePasswordEditor value={URI} onChange={onChange} core={core} />);
    expect(await screen.findByText('GitHub · me')).toBeInTheDocument();
    expect(await screen.findByLabelText('One-time password')).toHaveTextContent('123 456');
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('reports an unreadable existing value', async () => {
    const core = fakeCore({ parse: vi.fn().mockRejectedValue(new Error('corrupt')) });
    render(<OneTimePasswordEditor value={URI} onChange={vi.fn()} core={core} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corrupt');
  });
});

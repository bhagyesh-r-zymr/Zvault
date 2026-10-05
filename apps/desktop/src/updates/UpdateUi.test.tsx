import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheck } from './api.js';
import { UpdateBanner } from './UpdateBanner.js';
import { UpdatePanel } from './UpdatePanel.js';

const state = vi.hoisted(() => ({ value: {} }));
const store = vi.hoisted(() => ({
  checkNow: vi.fn(() => Promise.resolve()),
  install: vi.fn(() => Promise.resolve()),
  dismiss: vi.fn(),
}));

vi.mock('./store.js', () => ({
  updateStore: store,
  useUpdates: () => state.value,
  progressText: (p: { downloaded: number } | null) =>
    p ? `Downloading… ${p.downloaded}` : 'Downloading…',
}));

const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  currentVersion: '0.1.2',
  enabled: true,
  available: { version: '0.1.3', notes: null },
  ...over,
});
const set = (over: Record<string, unknown>) => {
  state.value = {
    check: null,
    checking: false,
    installing: false,
    progress: null,
    error: null,
    dismissed: null,
    ...over,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  set({});
});
afterEach(() => vi.useRealTimers());

describe('UpdateBanner', () => {
  it('checks at launch and renders nothing without an update', () => {
    const { container } = render(<UpdateBanner />);
    expect(store.checkNow).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden once that version was put off', () => {
    set({ check: check(), dismissed: '0.1.3' });
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the update and lets the person install or defer', async () => {
    set({ check: check() });
    render(<UpdateBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('Zvault 0.1.3 is available');
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(store.dismiss).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(store.install).toHaveBeenCalled();
  });

  it('shows progress and hides the buttons while installing', () => {
    set({ check: check(), installing: true, progress: { downloaded: 5, total: 10 } });
    render(<UpdateBanner />);
    expect(screen.getByText('Downloading… 5')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('rechecks on focus only after the interval has passed', () => {
    vi.useFakeTimers();
    render(<UpdateBanner />);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(store.checkNow).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(31 * 60 * 1000);
    });
    expect(store.checkNow.mock.calls.length).toBeGreaterThanOrEqual(2);
    const n = store.checkNow.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(store.checkNow).toHaveBeenCalledTimes(n);
  });
});

describe('UpdatePanel', () => {
  it.each([
    [{}, 'Zvault checks for updates when it starts.'],
    [{ checking: true }, 'Checking for updates…'],
    [{ installing: true, progress: null }, 'Downloading…'],
    [{ check: check({ enabled: false, available: null }) }, 'This build does not update itself.'],
    [{ check: check({ available: null }) }, 'Zvault is up to date.'],
    [{ check: check() }, 'Zvault 0.1.3 is available. Installing restarts Zvault.'],
  ])('describes %j', (over, text) => {
    set(over);
    render(<UpdatePanel />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('checks for updates on request', async () => {
    set({ check: check({ available: null }) });
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(store.checkNow).toHaveBeenCalled();
  });

  it('disables checking for builds that do not update', () => {
    set({ check: check({ enabled: false, available: null }) });
    render(<UpdatePanel />);
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  });

  it('installs an available update and shows errors', async () => {
    set({ check: check(), error: 'signature mismatch' });
    render(<UpdatePanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('signature mismatch');
    await userEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(store.install).toHaveBeenCalled();
  });
});

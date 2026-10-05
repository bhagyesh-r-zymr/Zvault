import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockStatus } from './lock.js';

vi.mock('./lock.js', async (orig) => ({
  ...(await orig<typeof import('./lock.js')>()),
  lock: { unlockWithPassword: vi.fn(), unlockWithTouchId: vi.fn() },
}));

const { lock } = await import('./lock.js');
const { LockScreen } = await import('./LockScreen.js');

const status = (enrolled: boolean): LockStatus => ({
  locked: true,
  accountId: 'a',
  unlockMethod: null,
  settings: {
    idleTimeoutMins: 5,
    lockOnSleep: true,
    lockOnScreenLock: true,
    clipboardClearSecs: 30,
    stayUnlocked: false,
  },
  touchId: { available: true, enrolled },
});

function setup(enrolled = false, reason: 'idle' | null = 'idle') {
  const h = { onUnlocked: vi.fn(), onSignOut: vi.fn() };
  render(<LockScreen email="alice@b.co" status={status(enrolled)} reason={reason} {...h} />);
  return h;
}

beforeEach(() => vi.resetAllMocks());

describe('LockScreen', () => {
  it('shows who is locked out and why', () => {
    setup();
    expect(screen.getByText('alice@b.co')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText(/after a period of inactivity/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Touch ID/ })).toBeNull();
  });

  it('omits the reason when there is none', () => {
    setup(false, null);
    expect(screen.queryByText(/Zvault locked/)).toBeNull();
  });

  it('unlocks with the master password', async () => {
    vi.mocked(lock.unlockWithPassword).mockResolvedValue(undefined);
    const h = setup();
    await userEvent.type(screen.getByLabelText('Master password'), 'pw{Enter}');
    expect(lock.unlockWithPassword).toHaveBeenCalledWith('pw');
    expect(h.onUnlocked).toHaveBeenCalled();
  });

  it('shows a wrong password and lets the person retry', async () => {
    vi.mocked(lock.unlockWithPassword).mockRejectedValue('Wrong password');
    const h = setup();
    await userEvent.type(screen.getByLabelText('Master password'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    expect(h.onUnlocked).not.toHaveBeenCalled();
  });

  it('unlocks with Touch ID when enrolled', async () => {
    vi.mocked(lock.unlockWithTouchId).mockResolvedValue(undefined);
    const h = setup(true);
    await userEvent.click(screen.getByRole('button', { name: /Unlock with Touch ID/ }));
    expect(lock.unlockWithTouchId).toHaveBeenCalled();
    expect(h.onUnlocked).toHaveBeenCalled();
  });

  it('waits for Touch ID and shows its failure', async () => {
    let reject: (e: unknown) => void = () => undefined;
    vi.mocked(lock.unlockWithTouchId).mockReturnValue(new Promise((_, r) => (reject = r)));
    setup(true);
    await userEvent.click(screen.getByRole('button', { name: /Unlock with Touch ID/ }));
    expect(screen.getByText('Waiting for Touch ID…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    reject(new Error('cancelled'));
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled');
  });

  it('signs out', async () => {
    const h = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(h.onSignOut).toHaveBeenCalled();
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockSettings, LockStatus } from './lock.js';

vi.mock('./lock.js', () => ({
  lock: { setSettings: vi.fn(), enableTouchId: vi.fn(), disableTouchId: vi.fn() },
}));

const { lock } = await import('./lock.js');
const { LockSettingsPanel } = await import('./LockSettingsPanel.js');

const base: LockSettings = {
  idleTimeoutMins: 15,
  lockOnSleep: true,
  lockOnScreenLock: false,
  clipboardClearSecs: 90,
  stayUnlocked: false,
};
const status = (
  settings: Partial<LockSettings> = {},
  touchId = { available: true, enrolled: false },
): LockStatus => ({
  locked: false,
  accountId: 'a',
  unlockMethod: 'masterPassword',
  settings: { ...base, ...settings },
  touchId,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lock.setSettings).mockResolvedValue(base);
  vi.mocked(lock.enableTouchId).mockResolvedValue(undefined);
  vi.mocked(lock.disableTouchId).mockResolvedValue(undefined);
});

describe('LockSettingsPanel', () => {
  it('saves a changed idle timeout and clipboard delay', async () => {
    const onChanged = vi.fn();
    render(<LockSettingsPanel status={status()} onChanged={onChanged} />);
    expect(screen.getByRole('radio', { name: '15 min' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: '4 h' }));
    expect(lock.setSettings).toHaveBeenLastCalledWith({ ...base, idleTimeoutMins: 240 });
    expect(screen.getByRole('radio', { name: '4 h' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Never' }));
    expect(lock.setSettings).toHaveBeenLastCalledWith({ ...base, idleTimeoutMins: 0 });
    const idle = within(screen.getByRole('radiogroup', { name: 'Lock after inactivity' }));
    await userEvent.click(idle.getByRole('radio', { name: '5 min' }));
    expect(lock.setSettings).toHaveBeenLastCalledWith({ ...base, idleTimeoutMins: 5 });
    await userEvent.click(screen.getByRole('radio', { name: '30 s' }));
    expect(lock.setSettings).toHaveBeenLastCalledWith({
      ...base,
      idleTimeoutMins: 5,
      clipboardClearSecs: 30,
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('toggles the three switches', async () => {
    render(<LockSettingsPanel status={status()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: /Stay unlocked/ }));
    expect(lock.setSettings).toHaveBeenLastCalledWith({ ...base, stayUnlocked: true });
    await userEvent.click(screen.getByRole('switch', { name: /Lock when the Mac sleeps/ }));
    expect(lock.setSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ stayUnlocked: true, lockOnSleep: false }),
    );
    await userEvent.click(screen.getByRole('switch', { name: /Lock when the screen locks/ }));
    expect(lock.setSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ lockOnScreenLock: true }),
    );
  });

  it('keeps a custom saved duration as an option', () => {
    render(
      <LockSettingsPanel
        status={status({ idleTimeoutMins: 90, clipboardClearSecs: 120 })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: '90 min' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '2 min' })).toBeChecked();
  });

  it('shows a save failure', async () => {
    vi.mocked(lock.setSettings).mockRejectedValue('denied');
    render(<LockSettingsPanel status={status()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Never' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('denied');
  });

  it('enables and disables Touch ID', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<LockSettingsPanel status={status()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('switch', { name: /Unlock with Touch ID/ }));
    expect(lock.enableTouchId).toHaveBeenCalled();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    rerender(
      <LockSettingsPanel
        status={status({}, { available: true, enrolled: true })}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(screen.getByRole('switch', { name: /Unlock with Touch ID/ }));
    expect(lock.disableTouchId).toHaveBeenCalled();
  });

  it('disables Touch ID when the Mac lacks it, and shows enrollment errors', async () => {
    const { rerender } = render(
      <LockSettingsPanel
        status={status({}, { available: false, enrolled: false })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch', { name: /Unlock with Touch ID/ })).toBeDisabled();
    expect(screen.getByText('Touch ID is not available on this Mac')).toBeInTheDocument();
    vi.mocked(lock.enableTouchId).mockRejectedValue('cancelled');
    rerender(<LockSettingsPanel status={status()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: /Unlock with Touch ID/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled');
  });
});

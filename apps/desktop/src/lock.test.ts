import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_REASON_TEXT, lock, useActivityReporter } from './lock.js';
import { mockCore } from './test/tauri.js';

describe('lock bridge', () => {
  it('forwards each call to its Rust command', async () => {
    const settings = {
      idleTimeoutMins: 5,
      lockOnSleep: true,
      lockOnScreenLock: true,
      clipboardClearSecs: 30,
      stayUnlocked: false,
    };
    const table: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => lock.status(), 'lock_status', {}],
      [() => lock.lockNow(), 'lock_vault', {}],
      [() => lock.setSettings(settings), 'set_lock_settings', { settings }],
      [() => lock.enableTouchId(), 'enable_touch_id', {}],
      [() => lock.disableTouchId(), 'disable_touch_id', {}],
      [() => lock.unlockWithTouchId(), 'unlock_with_touch_id', {}],
      [() => lock.unlockWithPassword('pw'), 'unlock_with_password', { password: 'pw' }],
      [() => lock.saveForRestart('t', 'x'), 'stay_unlocked_save', { token: 't', expiresAt: 'x' }],
      [() => lock.restore(), 'stay_unlocked_restore', {}],
      [() => lock.copySecret('s'), 'copy_secret', { text: 's' }],
    ];
    const calls = mockCore(Object.fromEntries(table.map(([, c]) => [c, null])));
    for (const [fn, cmd, args] of table) {
      calls.mockClear();
      await fn();
      expect(calls).toHaveBeenCalledWith(cmd, args);
    }
  });

  it('subscribes to vault://locked', async () => {
    mockCore();
    const stop = await lock.onLocked(() => undefined);
    expect(typeof stop).toBe('function');
  });

  it('has text for every reason', () => {
    expect(Object.keys(LOCK_REASON_TEXT).sort()).toEqual([
      'idle',
      'manual',
      'screenLocked',
      'sleep',
    ]);
  });
});

describe('useActivityReporter', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('reports activity at most once per throttle window', () => {
    const calls = mockCore({ report_activity: null });
    renderHook(() => useActivityReporter(true));
    vi.setSystemTime(100_000);
    act(() => {
      window.dispatchEvent(new Event('keydown'));
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(calls.mock.calls.filter(([c]) => c === 'report_activity')).toHaveLength(1);
    vi.setSystemTime(110_000);
    act(() => {
      window.dispatchEvent(new Event('wheel'));
    });
    expect(calls.mock.calls.filter(([c]) => c === 'report_activity')).toHaveLength(2);
  });

  it('swallows report failures and stops when disabled', () => {
    const calls = mockCore({
      report_activity: () => {
        throw new Error('x');
      },
    });
    const { rerender, unmount } = renderHook(({ on }) => useActivityReporter(on), {
      initialProps: { on: true },
    });
    vi.setSystemTime(100_000);
    act(() => {
      window.dispatchEvent(new Event('pointermove'));
    });
    expect(calls).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    vi.setSystemTime(200_000);
    window.dispatchEvent(new Event('pointermove'));
    expect(calls).toHaveBeenCalledTimes(1);
    unmount();
  });
});

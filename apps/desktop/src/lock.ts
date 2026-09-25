import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';

/**
 * Bridge to the Rust lock session. Keys never reach the UI: it asks Rust to
 * unlock, lock or copy, and hears about locks through `vault://locked`.
 */

export type LockReason = 'manual' | 'idle' | 'sleep' | 'screenLocked';
export type UnlockMethod = 'masterPassword' | 'touchId' | 'restored';

export interface LockSettings {
  /** 0 never locks on idle. */
  idleTimeoutMins: number;
  lockOnSleep: boolean;
  lockOnScreenLock: boolean;
  clipboardClearSecs: number;
  /** Open unlocked after a quit or restart, for up to 14 days. */
  stayUnlocked: boolean;
}

/** Must match the ranges in `session.rs`. */
export const LOCK_LIMITS = {
  idleTimeoutMins: { min: 0, max: 1440 },
  clipboardClearSecs: { min: 10, max: 300 },
} as const;

export interface LockStatus {
  locked: boolean;
  accountId: string | null;
  unlockMethod: UnlockMethod | null;
  settings: LockSettings;
  touchId: { available: boolean; enrolled: boolean };
}

export const lock = {
  status: () => invoke<LockStatus>('lock_status'),
  lockNow: () => invoke<void>('lock_vault'),
  setSettings: (settings: LockSettings) => invoke<LockSettings>('set_lock_settings', { settings }),
  enableTouchId: () => invoke<void>('enable_touch_id'),
  disableTouchId: () => invoke<void>('disable_touch_id'),
  unlockWithTouchId: () => invoke<void>('unlock_with_touch_id'),
  /** Unlocks on this Mac with the master password, keeping the server session. */
  unlockWithPassword: (password: string) => invoke<void>('unlock_with_password', { password }),
  /** Saves the unlocked session for the next launch. A no-op unless "Stay unlocked" is on. */
  saveForRestart: (token: string, expiresAt: string) =>
    invoke<void>('stay_unlocked_save', { token, expiresAt }),
  /** Reopens the session saved by "Stay unlocked", or null to sign in. */
  restore: () =>
    invoke<{ email: string; token: string; expiresAt: string } | null>('stay_unlocked_restore'),
  /** Copies a secret; resolves to the seconds until it is cleared. */
  copySecret: (text: string) => invoke<number>('copy_secret', { text }),
  onLocked: (handler: (reason: LockReason) => void): Promise<UnlistenFn> =>
    listen<{ reason: LockReason }>('vault://locked', (e) => handler(e.payload.reason)),
};

export const LOCK_REASON_TEXT: Record<LockReason, string> = {
  manual: 'Zvault was locked.',
  idle: 'Zvault locked after a period of inactivity.',
  sleep: 'Zvault locked when your Mac went to sleep.',
  screenLocked: 'Zvault locked when your screen locked.',
};

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
const ACTIVITY_THROTTLE_MS = 5_000;

/** Tells Rust the user is active, at most once every few seconds. */
export function useActivityReporter(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const report = () => {
      const now = Date.now();
      if (now - last < ACTIVITY_THROTTLE_MS) return;
      last = now;
      invoke('report_activity').catch(() => undefined);
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, report, { passive: true });
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, report);
    };
  }, [enabled]);
}

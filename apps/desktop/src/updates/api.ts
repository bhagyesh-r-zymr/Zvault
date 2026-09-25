import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface UpdateCheck {
  currentVersion: string;
  /** False for dev builds and builds without an update key. */
  enabled: boolean;
  available: { version: string; notes: string | null } | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export const updatesApi = {
  check: () => invoke<UpdateCheck>('update_check'),
  /** Installs the update the last check found, then restarts Zvault. */
  install: () => invoke<void>('update_install'),
  onProgress: (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>('update://progress', (e) => cb(e.payload)),
};

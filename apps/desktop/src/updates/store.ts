import { useSyncExternalStore } from 'react';
import { updatesApi, type UpdateCheck, type UpdateProgress } from './api.js';

/**
 * Update state shared by the launch banner and Settings, so a check or an
 * install started in one shows in the other.
 */
export interface UpdateState {
  check: UpdateCheck | null;
  checking: boolean;
  installing: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  /** The banner was closed with "Later" for this version. */
  dismissed: string | null;
}

type Api = Pick<typeof updatesApi, 'check' | 'install' | 'onProgress'>;

export function createUpdateStore(api: Api) {
  let state: UpdateState = {
    check: null,
    checking: false,
    installing: false,
    progress: null,
    error: null,
    dismissed: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  return {
    get: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    async checkNow() {
      if (state.checking || state.installing) return;
      set({ checking: true, error: null });
      try {
        set({ check: await api.check() });
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ checking: false });
      }
    },
    /** Downloads, installs and restarts; resolves only if that fails. */
    async install() {
      if (state.installing || !state.check?.available) return;
      set({ installing: true, error: null, progress: null });
      const stop = await api.onProgress((progress) => set({ progress }));
      try {
        await api.install();
      } catch (e) {
        // The pending update is used up by a failed install; check again.
        set({ error: message(e), check: { ...state.check, available: null } });
      } finally {
        stop();
        set({ installing: false });
      }
    },
    dismiss() {
      set({ dismissed: state.check?.available?.version ?? null });
    },
  };
}

export const updateStore = createUpdateStore(updatesApi);

export function useUpdates(): UpdateState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.get);
}

export function progressText(p: UpdateProgress | null): string {
  if (!p) return 'Downloading…';
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  return p.total
    ? `Downloading… ${Math.min(100, Math.round((p.downloaded / p.total) * 100))}%`
    : `Downloading… ${mb(p.downloaded)} MB`;
}

import { describe, expect, it, vi } from 'vitest';
import type { UpdateCheck } from './api.js';
import { createUpdateStore, progressText } from './store.js';

const available: UpdateCheck = {
  currentVersion: '0.1.2',
  enabled: true,
  available: { version: '0.1.3', notes: null },
};

function fakeApi(check: UpdateCheck, install = vi.fn(() => Promise.resolve())) {
  return {
    check: vi.fn(() => Promise.resolve(check)),
    install,
    onProgress: vi.fn(() => Promise.resolve(() => undefined)),
  };
}

describe('update store', () => {
  it('records what a check found', async () => {
    const store = createUpdateStore(fakeApi(available));
    await store.checkNow();
    expect(store.get().check?.available?.version).toBe('0.1.3');
    expect(store.get().checking).toBe(false);
  });

  it('does not install without an available update', async () => {
    const api = fakeApi({ ...available, available: null });
    const store = createUpdateStore(api);
    await store.checkNow();
    await store.install();
    expect(api.install).not.toHaveBeenCalled();
  });

  it('reports a failed install and asks for a new check', async () => {
    const api = fakeApi(
      available,
      vi.fn(() => Promise.reject(new Error('signature mismatch'))),
    );
    const store = createUpdateStore(api);
    await store.checkNow();
    await store.install();
    expect(store.get().error).toBe('signature mismatch');
    expect(store.get().check?.available).toBeNull();
    expect(store.get().installing).toBe(false);
  });

  it('remembers which version was put off', async () => {
    const store = createUpdateStore(fakeApi(available));
    await store.checkNow();
    store.dismiss();
    expect(store.get().dismissed).toBe('0.1.3');
  });

  it('shows download progress', () => {
    expect(progressText({ downloaded: 5_000_000, total: 10_000_000 })).toBe('Downloading… 50%');
    expect(progressText({ downloaded: 2_500_000, total: null })).toBe('Downloading… 2.5 MB');
    expect(progressText(null)).toBe('Downloading…');
  });
});

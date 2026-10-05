import { describe, expect, it } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { updatesApi } from './api.js';

describe('updatesApi', () => {
  it('calls the update commands', async () => {
    const calls = mockCore({
      update_check: { currentVersion: '1', enabled: true, available: null },
      update_install: null,
    });
    await expect(updatesApi.check()).resolves.toMatchObject({ currentVersion: '1' });
    await updatesApi.install();
    expect(calls).toHaveBeenCalledWith('update_install', {});
    const stop = await updatesApi.onProgress(() => undefined);
    expect(typeof stop).toBe('function');
  });
});

import { describe, expect, it } from 'vitest';
import { thisDevice } from './device.js';
import { mockCore } from './test/tauri.js';

describe('thisDevice', () => {
  it('describes this Mac with the app version', async () => {
    mockCore({ 'plugin:app|version': '1.2.3' });
    await expect(thisDevice()).resolves.toEqual({
      name: 'Mac',
      platform: 'macos',
      appVersion: '1.2.3',
    });
  });

  it('falls back when the version is unavailable', async () => {
    mockCore();
    await expect(thisDevice()).resolves.toMatchObject({ appVersion: '0.0.0' });
  });
});

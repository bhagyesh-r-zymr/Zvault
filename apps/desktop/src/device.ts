import { getVersion } from '@tauri-apps/api/app';
import type { DeviceInfo } from '@zvault/shared';

/** How this app describes itself in the account's device list. */
export async function thisDevice(): Promise<DeviceInfo> {
  const appVersion = await getVersion().catch(() => '0.0.0');
  return { name: 'Mac', platform: 'macos', appVersion };
}

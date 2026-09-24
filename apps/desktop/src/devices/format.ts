import type { DeviceInfo } from '@zvault/shared';

const PLATFORM_LABELS: Record<DeviceInfo['platform'], string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  cli: 'Command line',
};

export function platformLabel(platform: DeviceInfo['platform']): string {
  return PLATFORM_LABELS[platform];
}

/** "Active now", "5 minutes ago", "3 days ago". */
export function lastActive(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 120) return 'Active now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
  return 'Active now';
}

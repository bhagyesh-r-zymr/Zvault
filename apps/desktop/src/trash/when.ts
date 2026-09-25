const DAY_MS = 24 * 60 * 60 * 1000;

/** "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(ms / DAY_MS);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Whole days until `iso`, rounded up, never below zero. */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY_MS));
}

/** "Deleted 2 days ago · 28 days left". */
export function trashLine(deletedAt: string, purgeAt: string, now = Date.now()): string {
  const left = daysLeft(purgeAt, now);
  const remaining = left <= 1 ? 'goes for good today' : `${left} days left`;
  return `Deleted ${ago(deletedAt, now)} · ${remaining}`;
}

/** "25 Sep, 14:02" in the viewer's locale. */
export function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

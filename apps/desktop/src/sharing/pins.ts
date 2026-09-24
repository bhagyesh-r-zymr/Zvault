/**
 * Trust-on-first-use pins of other people's sharing keys, by email. The first
 * key seen for an address is remembered; a different key later means the
 * server (or someone with access to it) may be impersonating that person, so
 * the UI warns and asks before using it.
 */

export type PinCheck = 'new' | 'match' | 'changed';

const STORAGE_KEY = 'zvault.sharing.pins.v1';

export interface PinStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(store: PinStore): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const normalize = (email: string) => email.trim().toLowerCase();

export function checkPin(email: string, publicKey: string, store: PinStore = localStorage): PinCheck {
  const pinned = read(store)[normalize(email)];
  if (pinned === undefined) return 'new';
  return pinned === publicKey ? 'match' : 'changed';
}

/** Remembers `publicKey` as the key for `email`, replacing any earlier pin. */
export function pinKey(email: string, publicKey: string, store: PinStore = localStorage): void {
  const pins = read(store);
  pins[normalize(email)] = publicKey;
  store.setItem(STORAGE_KEY, JSON.stringify(pins));
}

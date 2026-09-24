import { ListDevicesResponse, RevokeSessionsResponse, type DeviceSession } from '@zvault/shared';

export interface DevicesClientOptions {
  /** API origin, for example https://api.zvault.example */
  baseUrl: string;
  /** The current session's bearer token, or null when signed out. */
  getToken: () => string | null;
  fetch?: typeof fetch;
}

export class DevicesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DevicesApiError';
  }

  /** The current session is no longer valid, so the app should return to sign-in. */
  get signedOut(): boolean {
    return this.status === 401;
  }
}

export interface DevicesClient {
  list(): Promise<DeviceSession[]>;
  revoke(sessionId: string): Promise<void>;
  revokeOthers(): Promise<number>;
}

export function createDevicesClient(options: DevicesClientOptions): DevicesClient {
  const doFetch = options.fetch ?? fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(method: string, path: string): Promise<unknown> {
    const token = options.getToken();
    if (!token) throw new DevicesApiError(401, 'Not signed in');
    const res = await doFetch(`${base}/v1/devices${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) {
      const message =
        res.status === 401
          ? 'Your session has ended. Sign in again.'
          : res.status === 404
            ? 'That device is already signed out.'
            : res.status === 429
              ? 'Too many attempts. Try again in a minute.'
              : `Request failed (${res.status})`;
      throw new DevicesApiError(res.status, message);
    }
    return res.status === 204 ? undefined : res.json();
  }

  return {
    async list() {
      return ListDevicesResponse.parse(await call('GET', '')).devices;
    },
    async revoke(sessionId) {
      await call('DELETE', `/${encodeURIComponent(sessionId)}`);
    },
    async revokeOthers() {
      return RevokeSessionsResponse.parse(await call('POST', '/revoke-others')).revoked;
    },
  };
}

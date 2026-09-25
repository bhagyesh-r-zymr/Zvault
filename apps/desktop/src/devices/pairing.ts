import { invoke } from '@tauri-apps/api/core';
import { CreatePairingResponse, PairingView, type PairingGrant } from '@zvault/shared';
import { DevicesApiError } from './client.js';

/** The Rust side of adding a phone. The pairing secret and keyset stay in Rust. */
export const pairingCore = {
  begin: () => invoke<{ claimToken: string }>('pairing_begin'),
  qr: (id: string, api: string) => invoke<string>('pairing_qr', { id, api }),
  code: (publicKey: string) => invoke<string>('pairing_code', { publicKey }),
  grant: (publicKey: string) => invoke<PairingGrant>('pairing_grant', { publicKey }),
  cancel: () => invoke<void>('pairing_cancel'),
};

export interface PairingClient {
  create(claimToken: string): Promise<CreatePairingResponse>;
  get(id: string): Promise<PairingView>;
  approve(id: string, grant: PairingGrant): Promise<void>;
  deny(id: string): Promise<void>;
}

export function createPairingClient(options: {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
}): PairingClient {
  const doFetch = options.fetch ?? fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = options.getToken();
    if (!token) throw new DevicesApiError(401, 'Not signed in');
    const res = await doFetch(`${base}/v1/pairings${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) {
      const message =
        res.status === 401
          ? 'Your session has ended. Sign in again.'
          : res.status === 404
            ? 'This QR code has expired. Show a new one.'
            : res.status === 409
              ? 'That phone is no longer waiting. Show a new QR code.'
              : res.status === 429
                ? 'Too many attempts. Try again in a minute.'
                : `Request failed (${res.status})`;
      throw new DevicesApiError(res.status, message);
    }
    return res.status === 204 ? undefined : res.json();
  }

  return {
    async create(claimToken) {
      return CreatePairingResponse.parse(await call('POST', '', { claimToken }));
    },
    async get(id) {
      return PairingView.parse(await call('GET', `/${encodeURIComponent(id)}`));
    },
    async approve(id, grant) {
      await call('POST', `/${encodeURIComponent(id)}/approve`, { grant });
    },
    async deny(id) {
      await call('POST', `/${encodeURIComponent(id)}/deny`);
    },
  };
}

/** Groups a six-digit code for reading aloud: `472918` → `472 918`. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

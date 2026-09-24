import {
  RecoveryCodesResponse,
  TotpSetupResponse,
  TwoFactorStatusResponse,
  type TwoFactorProof,
} from '@zvault/shared';

/**
 * Sends an authenticated JSON request to the Zvault API and resolves with the
 * parsed body (undefined for 204), rejecting with `ApiError` otherwise. The
 * session layer supplies this so 2FA stays independent of how auth works.
 */
export type Transport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** A fetch-based transport; `authHeaders` comes from the signed-in session. */
export function fetchTransport(
  baseUrl: string,
  authHeaders: () => Record<string, string>,
): Transport {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: body === undefined ? null : JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 204) return undefined;
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, json.error, json.message ?? res.statusText);
    return json;
  };
}

export function twoFactorApi(send: Transport) {
  return {
    status: async () => TwoFactorStatusResponse.parse(await send('GET', '/2fa')),
    beginSetup: async () => TotpSetupResponse.parse(await send('POST', '/2fa/totp/setup')),
    confirmSetup: async (code: string) =>
      RecoveryCodesResponse.parse(await send('POST', '/2fa/totp/confirm', { code })),
    regenerateRecoveryCodes: async (proof: TwoFactorProof) =>
      RecoveryCodesResponse.parse(await send('POST', '/2fa/recovery-codes', proof)),
    disable: async (proof: TwoFactorProof) => {
      await send('POST', '/2fa/disable', proof);
    },
  };
}

export type TwoFactorApi = ReturnType<typeof twoFactorApi>;

/** User-facing text for a failed 2FA request. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_two_factor_code')
      return 'That code didn’t work. Check your authenticator and try again.';
    if (e.code === 'two_factor_locked')
      return 'Too many incorrect codes. Wait 15 minutes and try again.';
    if (e.code === 'two_factor_setup_not_started')
      return 'Setup expired. Start again to get a new QR code.';
    if (e.status === 401) return 'Your session has ended. Sign in again.';
    return e.message;
  }
  return 'Couldn’t reach Zvault. Check your connection and try again.';
}

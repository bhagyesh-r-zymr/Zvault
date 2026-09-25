import {
  AccountRecoveryStatus,
  ApiError,
  LoginFinishResponse,
  LoginStartResponse,
  LoginTwoFactorResponse,
  ReauthenticatedResponse,
  RecoverCompleteResponse,
  RecoverVerifyResponse,
  SessionResponse,
  SignupCompleteResponse,
  SignupVerifyResponse,
  type LoginFinishRequest,
  type AccountRecoverySetupRequest,
  type LoginTwoFactorRequest,
  type PasswordChangeRequest,
  type RecoverCompleteRequest,
  type RecoverVerifyRequest,
  type SignupCompleteRequest,
} from '@zvault/shared';
import type { z } from 'zod';

/** Set `VITE_API_URL` at build time; must also be allowed by `connect-src` in tauri.conf.json. */
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable `error` from the body, e.g. `invalid_two_factor_code`. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The `error` and `message` fields some endpoints return instead of the standard shape. */
const errorFields = (json: unknown): { error?: unknown; message?: unknown } =>
  typeof json === 'object' && json !== null ? json : {};

async function call<T extends z.ZodType>(
  path: string,
  init: { body?: unknown; token?: string; method?: string },
  schema: T | null,
): Promise<z.output<T>> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiRequestError(0, "Can't reach the Zvault server. Check your connection.");
  }
  const json: unknown =
    res.status === 204 || res.status === 202 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    const { error, message } = errorFields(json);
    const code = typeof error === 'string' ? error : undefined;
    if (res.status === 429 && !code) {
      throw new ApiRequestError(429, 'Too many attempts. Wait a minute and try again.');
    }
    const text = parsed.success
      ? parsed.data.message
      : typeof message === 'string'
        ? message
        : `Request failed (${res.status})`;
    throw new ApiRequestError(res.status, text, code);
  }
  return (schema ? schema.parse(json) : undefined) as z.output<T>;
}

export const api = {
  signupStart: (email: string) => call('auth/signup/start', { body: { email } }, null),
  signupVerify: (email: string, code: string) =>
    call('auth/signup/verify', { body: { email, code } }, SignupVerifyResponse),
  signupComplete: (body: SignupCompleteRequest) =>
    call('auth/signup/complete', { body }, SignupCompleteResponse),
  loginStart: (email: string) => call('auth/login/start', { body: { email } }, LoginStartResponse),
  loginFinish: (body: LoginFinishRequest) =>
    call('auth/login/finish', { body }, LoginFinishResponse),
  loginTwoFactor: (body: LoginTwoFactorRequest) =>
    call('auth/login/two-factor', { body }, LoginTwoFactorResponse),
  session: (token: string) => call('auth/session', { token }, SessionResponse),
  logout: (token: string) => call('auth/logout', { token, method: 'POST' }, null),
  changePassword: (token: string, body: PasswordChangeRequest) =>
    call('auth/password', { token, body }, ReauthenticatedResponse),
  recoveryStatus: (token: string) => call('auth/recovery', { token }, AccountRecoveryStatus),
  setUpRecovery: (token: string, body: AccountRecoverySetupRequest) =>
    call('auth/recovery', { token, body, method: 'PUT' }, ReauthenticatedResponse),
  recoverStart: (email: string) => call('auth/recover/start', { body: { email } }, null),
  recoverVerify: (body: RecoverVerifyRequest) =>
    call('auth/recover/verify', { body }, RecoverVerifyResponse),
  recoverComplete: (body: RecoverCompleteRequest) =>
    call('auth/recover/complete', { body }, RecoverCompleteResponse),
};

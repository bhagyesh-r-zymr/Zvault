import {
  ApiError,
  LoginFinishResponse,
  LoginStartResponse,
  SessionResponse,
  SignupCompleteResponse,
  SignupVerifyResponse,
  type LoginFinishRequest,
  type SignupCompleteRequest,
} from '@zvault/shared';
import type { z } from 'zod';

/** Set `VITE_API_URL` at build time; must also be allowed by `connect-src` in tauri.conf.json. */
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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
  const json: unknown = res.status === 204 || res.status === 202 ? null : await res.json();
  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (res.status === 429) {
      throw new ApiRequestError(429, 'Too many attempts. Wait a minute and try again.');
    }
    throw new ApiRequestError(
      res.status,
      parsed.success ? parsed.data.message : `Request failed (${res.status})`,
    );
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
  session: (token: string) => call('auth/session', { token }, SessionResponse),
  logout: (token: string) => call('auth/logout', { token, method: 'POST' }, null),
};

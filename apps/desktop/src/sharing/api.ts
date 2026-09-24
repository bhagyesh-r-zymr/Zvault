import {
  OutgoingUserShare,
  ShareLinkList,
  ShareLinkSummary,
  SharingKeyResponse,
  UserShareList,
  type CreateShareLinkInput,
  type CreateUserShareInput,
} from '@zvault/shared';
import type { z } from 'zod';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const SHARE_ORIGIN: string = import.meta.env.VITE_SHARE_ORIGIN ?? 'http://localhost:1430';

/**
 * Supplies the session credentials once sign-in exists; until then requests
 * go out unauthenticated and the API answers 401.
 */
export type AuthHeaders = () => Record<string, string>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sharingApi(authHeaders: AuthHeaders = () => ({})) {
  async function call<T extends z.ZodType>(
    schema: T | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<z.output<T>> {
    const res = await fetch(`${API_URL}/v1${path}`, {
      method,
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: unknown };
      throw new ApiError(
        res.status,
        typeof data.message === 'string' ? data.message : `Request failed (${res.status})`,
      );
    }
    return (schema ? schema.parse(await res.json()) : undefined) as z.output<T>;
  }

  return {
    createLink: (req: CreateShareLinkInput) => call(ShareLinkSummary, 'POST', '/shares/links', req),
    listLinks: () => call(ShareLinkList, 'GET', '/shares/links'),
    revokeLink: (id: string) => call(null, 'DELETE', `/shares/links/${id}`),
    publishKey: (publicKey: string) =>
      call(SharingKeyResponse, 'PUT', '/shares/keys/me', { publicKey }),
    lookupKey: (email: string) =>
      call(SharingKeyResponse, 'GET', `/shares/keys?email=${encodeURIComponent(email)}`),
    shareWithUser: (req: CreateUserShareInput) =>
      call(OutgoingUserShare, 'POST', '/shares/users', req),
    listUserShares: () => call(UserShareList, 'GET', '/shares/users'),
    removeUserShare: (id: string) => call(null, 'DELETE', `/shares/users/${id}`),
  };
}

export type SharingApi = ReturnType<typeof sharingApi>;

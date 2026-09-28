import {
  API_VERSION,
  ApiError as ApiErrorBody,
  ListTokensResponse,
  TokenView,
  type CreateTokenRequest,
} from '@zvault/shared';
import { invoke } from '@tauri-apps/api/core';
import type { ApiSession } from '../vault/api.js';
import { TeamError } from './teamApi.js';

/** What the Rust core returns for a new token: the API body's keys, and the token itself. */
export interface IssuedToken {
  id: string;
  verifier: string;
  encryptedProjectKey: CreateTokenRequest['encryptedProjectKey'];
  environments: CreateTokenRequest['environments'];
  /** `zvt_…`, shown once. Never sent to the API. */
  token: string;
}

export interface TokensCore {
  /** Wraps the open project and environment keys for a new token (`agent_token_issue`). */
  issue(
    projectId: string,
    environments: { environmentId: string; keyVersion: number }[],
  ): Promise<IssuedToken>;
}

export const tokensCore: TokensCore = {
  issue: (projectId, environments) => invoke('agent_token_issue', { projectId, environments }),
};

const ERRORS: Record<string, string> = {
  manage_required: 'Only managers of this environment can make tokens for it.',
  no_access: "This device doesn't hold that environment's key.",
  key_version_changed: 'The environment key was just rotated. Try again.',
  limit_reached: 'This project already has 50 tokens. Revoke one first.',
  invalid_expiry: 'Tokens can last at most a year.',
};

/** `/projects/:id/tokens`: a project's access tokens for cloud agents and CI. */
export class TokensApi {
  constructor(
    private readonly session: ApiSession,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async list(projectId: string): Promise<TokenView[]> {
    return ListTokensResponse.parse(await this.request('GET', `/projects/${projectId}/tokens`))
      .tokens;
  }

  async create(projectId: string, body: CreateTokenRequest): Promise<TokenView> {
    return TokenView.parse(await this.request('POST', `/projects/${projectId}/tokens`, body));
  }

  async revoke(projectId: string, tokenId: string): Promise<void> {
    await this.request('DELETE', `/projects/${projectId}/tokens/${tokenId}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.session.accessToken()}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.session.baseUrl}/${API_VERSION}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TeamError(0, "Can't reach the Zvault server. Check your connection.");
    }
    const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      const code = (json as { error?: unknown } | undefined)?.error;
      const parsed = ApiErrorBody.safeParse(json);
      throw new TeamError(
        res.status,
        (typeof code === 'string' && ERRORS[code]) ||
          (parsed.success ? parsed.data.message : `Request failed (${res.status})`),
      );
    }
    return json;
  }
}

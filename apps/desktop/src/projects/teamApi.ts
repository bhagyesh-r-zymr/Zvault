import {
  API_VERSION,
  ApiError as ApiErrorBody,
  AccessRequestView,
  EnvironmentAccess,
  Grant,
  ListAccessRequestsResponse,
  ListOrgsResponse,
  OrgDetail,
  OrgGroup,
  OrgMember,
  ProjectAccessResponse,
  type AddEnvironmentWrapsRequest,
  type AddProjectWrapsRequest,
  type ApproveAccessRequest,
  type InviteMemberInput,
  type OrgRole,
  type OrgSummary,
  type PrincipalRef,
  type PutGrantInput,
  type RotateEnvironmentKeyRequest,
} from '@zvault/shared';
import type { ApiSession } from '../vault/api.js';

/** A failed team request, with the server's message when it sent one. */
export class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * HTTP client for organizations (`/orgs`) and per-environment access
 * (`/access`). Key wraps, rotations and releases are produced by the Rust
 * core (`teamKeysCore`) and only passed through here.
 */
export class TeamApi {
  constructor(
    private readonly session: ApiSession,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async listOrgs(): Promise<OrgSummary[]> {
    return ListOrgsResponse.parse(await this.request('GET', '/orgs')).orgs;
  }

  async org(orgId: string): Promise<OrgDetail> {
    return OrgDetail.parse(await this.request('GET', `/orgs/${orgId}`));
  }

  /** `publicKey` is this account's sharing key, which environment keys get wrapped to. */
  async createOrg(name: string, publicKey: string): Promise<OrgDetail> {
    return OrgDetail.parse(await this.request('POST', '/orgs', { name, publicKey }));
  }

  async acceptInvite(orgId: string, publicKey: string): Promise<OrgDetail> {
    return OrgDetail.parse(await this.request('POST', `/orgs/${orgId}/join`, { publicKey }));
  }

  async invite(orgId: string, body: InviteMemberInput): Promise<OrgMember> {
    return OrgMember.parse(await this.request('POST', `/orgs/${orgId}/members`, body));
  }

  async changeRole(orgId: string, accountId: string, role: OrgRole): Promise<void> {
    await this.request('PATCH', `/orgs/${orgId}/members/${accountId}`, { role });
  }

  async removeMember(orgId: string, accountId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/members/${accountId}`);
  }

  async createGroup(orgId: string, name: string): Promise<OrgGroup> {
    return OrgGroup.parse(await this.request('POST', `/orgs/${orgId}/groups`, { name }));
  }

  async deleteGroup(orgId: string, groupId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/groups/${groupId}`);
  }

  async addToGroup(orgId: string, groupId: string, accountId: string): Promise<void> {
    await this.request('PUT', `/orgs/${orgId}/groups/${groupId}/members/${accountId}`);
  }

  async removeFromGroup(orgId: string, groupId: string, accountId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/groups/${groupId}/members/${accountId}`);
  }

  async removeAgent(orgId: string, agentId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/agents/${agentId}`);
  }

  /** Shares a project with an organization. Only its owner can. */
  async linkProject(projectId: string, orgId: string): Promise<ProjectAccessResponse> {
    return ProjectAccessResponse.parse(
      await this.request('PUT', `/access/projects/${projectId}/org`, { orgId }),
    );
  }

  /** 404 when the project is not shared with an organization. */
  async projectAccess(projectId: string): Promise<ProjectAccessResponse> {
    return ProjectAccessResponse.parse(await this.request('GET', `/access/projects/${projectId}`));
  }

  async environment(envId: string): Promise<EnvironmentAccess> {
    return EnvironmentAccess.parse(await this.request('GET', `/access/environments/${envId}`));
  }

  async putGrant(envId: string, body: PutGrantInput): Promise<Grant> {
    return Grant.parse(await this.request('PUT', `/access/environments/${envId}/grants`, body));
  }

  async deleteGrant(envId: string, principal: PrincipalRef): Promise<void> {
    await this.request(
      'DELETE',
      `/access/environments/${envId}/grants/${principal.type}/${principal.id}`,
    );
  }

  /** Hands the project key to members who have access but no key yet. */
  async addProjectWraps(projectId: string, body: AddProjectWrapsRequest): Promise<void> {
    await this.request('POST', `/access/projects/${projectId}/keys`, body);
  }

  /** Hands an environment's current key to members who have access but no key yet. */
  async addEnvironmentWraps(envId: string, body: AddEnvironmentWrapsRequest): Promise<void> {
    await this.request('POST', `/access/environments/${envId}/keys`, body);
  }

  /** 422 names the members the new key still has to be wrapped to. */
  async rotateEnvironment(
    envId: string,
    body: RotateEnvironmentKeyRequest,
  ): Promise<EnvironmentAccess> {
    return EnvironmentAccess.parse(
      await this.request('POST', `/access/environments/${envId}/rotate`, body),
    );
  }

  /** Managers get the pending requests; everyone else gets their own. */
  async listRequests(envId: string): Promise<AccessRequestView[]> {
    return ListAccessRequestsResponse.parse(
      await this.request('GET', `/access/environments/${envId}/requests`),
    ).requests;
  }

  async approveRequest(requestId: string, body: ApproveAccessRequest): Promise<AccessRequestView> {
    return AccessRequestView.parse(
      await this.request('POST', `/access/requests/${requestId}/approve`, body),
    );
  }

  async denyRequest(requestId: string): Promise<AccessRequestView> {
    return AccessRequestView.parse(
      await this.request('POST', `/access/requests/${requestId}/deny`),
    );
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
      const parsed = ApiErrorBody.safeParse(json);
      throw new TeamError(
        res.status,
        parsed.success ? parsed.data.message : `Request failed (${res.status})`,
      );
    }
    return json;
  }
}

export const MANAGERS_ONLY = 'Only managers/owners can change this.';

/** A readable message for a failed team request. */
export function teamError(e: unknown, fallback: string): string {
  if (e instanceof TeamError) {
    if (e.status === 403) return MANAGERS_ONLY;
    if (e.status === 429) return 'Too many changes at once. Wait a minute and try again.';
    return e.message;
  }
  return e instanceof Error ? e.message : fallback;
}

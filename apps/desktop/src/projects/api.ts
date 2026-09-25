import {
  API_VERSION,
  EntryConflictResponse,
  EnvironmentAccess,
  ListProjectsResponse,
  MyProjectKeysResponse,
  ProjectEntry,
  ProjectRecord,
  ProjectTrashResponse,
  SecretHistoryResponse,
  SyncProjectResponse,
  type AddEnvironmentWrapsRequest,
  type AddProjectWrapsRequest,
  type ApproveAccessRequest,
  type CreateProjectRequest,
  type EntryType,
  type PutEnvironmentRequest,
  type PutFolderRequest,
  type PutSecretRequest,
  type RotateEnvironmentKeyRequest,
  type SecretVersion,
  type TrashedSecret,
  type UpdateProjectRequest,
} from '@zvault/shared';
import { ApiError, type ApiSession } from '../vault/api.js';

export { ApiError };

/** Thrown when a write was based on a revision someone else already replaced. */
export class EntryConflictError extends Error {
  constructor(readonly current: ProjectEntry) {
    super('This was changed on another device. Your view has been refreshed.');
  }
}

const PATHS: Record<EntryType, string> = {
  environment: 'environments',
  folder: 'folders',
  secret: 'secrets',
};

/** Readable text for a 403 from the projects API, by the error code it sends. */
export function forbiddenMessage(code: unknown): string {
  return code === 'owner_only'
    ? 'Only the project owner or an organization admin can change this.'
    : 'You can view this environment but not change it.';
}

/** A 403 from the projects API, with a message people can act on. */
export class ForbiddenError extends ApiError {
  constructor(code: unknown) {
    super(403);
    this.message = forbiddenMessage(code);
  }
}

/** HTTP client for the project routes. Every body it sends is ciphertext. */
export class ProjectsApi {
  constructor(
    private readonly session: ApiSession,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async listProjects(): Promise<ProjectRecord[]> {
    return ListProjectsResponse.parse(await this.request('GET', '/projects')).projects;
  }

  async createProject(body: CreateProjectRequest): Promise<ProjectRecord> {
    return ProjectRecord.parse(await this.request('POST', '/projects', body));
  }

  async updateProject(projectId: string, body: UpdateProjectRequest): Promise<ProjectRecord> {
    return ProjectRecord.parse(await this.request('PATCH', `/projects/${projectId}`, body));
  }

  /** Deletes a project with everything in it (owner only). */
  async deleteProject(projectId: string): Promise<void> {
    await this.request('DELETE', `/projects/${projectId}`);
  }

  async syncProject(projectId: string, since: number): Promise<SyncProjectResponse> {
    const path = `/projects/${projectId}/changes?since=${since}`;
    return SyncProjectResponse.parse(await this.request('GET', path));
  }

  async putEnvironment(
    projectId: string,
    id: string,
    body: PutEnvironmentRequest,
  ): Promise<ProjectEntry> {
    return this.putEntry(projectId, 'environment', id, body);
  }

  async putFolder(projectId: string, id: string, body: PutFolderRequest): Promise<ProjectEntry> {
    return this.putEntry(projectId, 'folder', id, body);
  }

  async putSecret(projectId: string, id: string, body: PutSecretRequest): Promise<ProjectEntry> {
    return this.putEntry(projectId, 'secret', id, body);
  }

  async deleteEntry(
    projectId: string,
    type: EntryType,
    id: string,
    baseRevision: number,
  ): Promise<ProjectEntry> {
    const path = `/projects/${projectId}/${PATHS[type]}/${id}?baseRevision=${baseRevision}`;
    return ProjectEntry.parse(await this.request('DELETE', path));
  }

  /** Earlier versions of a secret, newest first. */
  async secretHistory(projectId: string, secretId: string): Promise<SecretVersion[]> {
    const path = `/projects/${projectId}/secrets/${secretId}/history`;
    return SecretHistoryResponse.parse(await this.request('GET', path)).versions;
  }

  /** Secrets deleted in the last 30 days, newest first. */
  async trash(projectId: string): Promise<TrashedSecret[]> {
    return ProjectTrashResponse.parse(await this.request('GET', `/projects/${projectId}/trash`))
      .secrets;
  }

  /** Deletes one trashed secret for good, or empties the trash (`secretId` null). */
  async purgeTrash(projectId: string, secretId: string | null): Promise<void> {
    await this.request('DELETE', `/projects/${projectId}/trash${secretId ? `/${secretId}` : ''}`);
  }

  /** The caller's member wraps in a project someone shared with them. */
  async myKeys(projectId: string): Promise<MyProjectKeysResponse> {
    return MyProjectKeysResponse.parse(
      await this.request('GET', `/access/projects/${projectId}/keys/me`),
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

  async rotateEnvironment(
    envId: string,
    body: RotateEnvironmentKeyRequest,
  ): Promise<EnvironmentAccess> {
    return EnvironmentAccess.parse(
      await this.request('POST', `/access/environments/${envId}/rotate`, body),
    );
  }

  async approveRequest(requestId: string, body: ApproveAccessRequest): Promise<void> {
    await this.request('POST', `/access/requests/${requestId}/approve`, body);
  }

  private async putEntry(
    projectId: string,
    type: EntryType,
    id: string,
    body: unknown,
  ): Promise<ProjectEntry> {
    const path = `/projects/${projectId}/${PATHS[type]}/${id}`;
    return ProjectEntry.parse(await this.request('PUT', path, body));
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.session.accessToken()}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.session.baseUrl}/${API_VERSION}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (res.status === 409) {
      const conflict = EntryConflictResponse.safeParse(json);
      if (conflict.success) throw new EntryConflictError(conflict.data.current);
    }
    if (res.status === 403) {
      const code = json && typeof json === 'object' && 'error' in json ? json.error : undefined;
      throw new ForbiddenError(code);
    }
    if (!res.ok) throw new ApiError(res.status);
    return json;
  }
}

/** A readable message for a failed project write. */
export function writeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return e instanceof ForbiddenError ? e.message : forbiddenMessage(null);
    if (e.status === 404) return 'This project is no longer available.';
    if (e.status === 400) return 'The server turned this down. Check the limits and try again.';
  }
  return e instanceof Error ? e.message : fallback;
}

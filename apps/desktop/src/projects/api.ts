import {
  API_VERSION,
  EntryConflictResponse,
  ListProjectsResponse,
  ProjectEntry,
  ProjectRecord,
  SyncProjectResponse,
  type CreateProjectRequest,
  type EntryType,
  type PutEnvironmentRequest,
  type PutFolderRequest,
  type PutSecretRequest,
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
    if (!res.ok) throw new ApiError(res.status);
    return json;
  }
}

/** A readable message for a failed project write. */
export function writeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Only the project owner can change this.';
    if (e.status === 404) return 'This project is no longer available.';
    if (e.status === 400) return 'The server turned this down. Check the limits and try again.';
  }
  return e instanceof Error ? e.message : fallback;
}

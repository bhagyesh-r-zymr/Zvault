import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ACCOUNT_KID,
  MAX_ENVIRONMENTS_PER_PROJECT,
  MAX_FOLDERS_PER_PROJECT,
  MAX_PROJECTS_PER_ACCOUNT,
  MAX_SECRETS_PER_PROJECT,
  type CreateProjectRequest,
  type EntryConflictResponse,
  type ProjectEntry,
  type ProjectRecord,
  type PutEnvironmentRequest,
  type PutFolderRequest,
  type PutSecretRequest,
  type SyncProjectResponse,
  type UpdateProjectRequest,
} from '@zvault/shared';
import { ProjectPolicy } from '../access/project-policy.js';
import type { AuthenticatedUser } from '../vault/current-user.js';
import {
  ProjectsStore,
  type EntryWrite,
  type ProjectAccess,
  type StoredProject,
} from './projects.store.js';

const LIMITS = {
  environment: MAX_ENVIRONMENTS_PER_PROJECT,
  folder: MAX_FOLDERS_PER_PROJECT,
  secret: MAX_SECRETS_PER_PROJECT,
} as const;

/**
 * Access rules. Holding the project key makes an account a member: it can
 * read the project and write secrets, but only values of environments whose
 * keys it holds. Changing the project's structure (environments, folders,
 * the project itself) is for the owner.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly store: ProjectsStore,
    private readonly policy: ProjectPolicy,
  ) {}

  async list(user: AuthenticatedUser): Promise<ProjectRecord[]> {
    for (const p of await this.store.listProjects(user.id)) {
      await this.policy.beforeAccess(p.row.id);
    }
    return (await this.store.listProjects(user.id)).map((p) => toRecord(p, user));
  }

  async create(user: AuthenticatedUser, req: CreateProjectRequest): Promise<ProjectRecord> {
    const envIds = new Set(req.environments.map((e) => e.id));
    const bound =
      req.encryptedKey.kid === ACCOUNT_KID &&
      req.encryptedMeta.kid === req.id &&
      req.environments.every(
        (e) => e.encryptedKey.kid === ACCOUNT_KID && e.encryptedMeta.kid === e.id,
      );
    if (!bound) throw new BadRequestException({ error: 'key_mismatch' });
    if (envIds.size !== req.environments.length || envIds.has(req.id)) {
      throw new BadRequestException({ error: 'duplicate_id' });
    }
    if ((await this.store.countOwned(user.id)) >= MAX_PROJECTS_PER_ACCOUNT) {
      throw new BadRequestException({ error: 'limit_reached' });
    }
    if (!(await this.store.createProject({ ...req, ownerId: user.id, now: new Date() }))) {
      throw new ConflictException({ error: 'project_exists' });
    }
    return this.get(user, req.id);
  }

  async get(user: AuthenticatedUser, projectId: string): Promise<ProjectRecord> {
    await this.policy.beforeAccess(projectId);
    const project = await this.store.getProject(projectId, user.id);
    if (!project) throw new NotFoundException();
    return toRecord(project, user);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    req: UpdateProjectRequest,
  ): Promise<ProjectRecord> {
    await this.assertOwner(await this.access(user, projectId), user, projectId);
    if (req.encryptedMeta.kid !== projectId) {
      throw new BadRequestException({ error: 'key_mismatch' });
    }
    if (
      !(await this.store.updateProject(projectId, req.baseRevision, req.encryptedMeta, new Date()))
    ) {
      throw new ConflictException({ error: 'conflict', current: await this.get(user, projectId) });
    }
    return this.get(user, projectId);
  }

  async remove(user: AuthenticatedUser, projectId: string): Promise<void> {
    // Deleting a whole project stays with its owner, even in an org.
    const access = await this.access(user, projectId);
    if (access.ownerId !== user.id) throw new ForbiddenException({ error: 'owner_only' });
    await this.store.deleteProject(projectId);
  }

  async sync(
    user: AuthenticatedUser,
    projectId: string,
    since: number,
    limit: number,
  ): Promise<SyncProjectResponse> {
    await this.access(user, projectId);
    // Fetch one extra to learn whether another page follows.
    const changes = await this.store.listChanges(projectId, user.id, since, limit + 1);
    const entries = changes.slice(0, limit);
    return { entries, cursor: entries.at(-1)?.seq ?? since, hasMore: changes.length > limit };
  }

  async putEnvironment(
    user: AuthenticatedUser,
    projectId: string,
    id: string,
    req: PutEnvironmentRequest,
  ): Promise<ProjectEntry> {
    await this.assertOwner(await this.access(user, projectId), user, projectId);
    if (
      req.encryptedMeta.kid !== id ||
      (req.encryptedKey && req.encryptedKey.kid !== ACCOUNT_KID)
    ) {
      throw new BadRequestException({ error: 'key_mismatch' });
    }
    if (req.baseRevision === 0 && !req.encryptedKey) {
      throw new BadRequestException({ error: 'key_required' });
    }
    return this.write(user, {
      projectId,
      id,
      type: 'environment',
      baseRevision: req.baseRevision,
      encryptedMeta: req.encryptedMeta,
      // The key is fixed once the environment exists; values are sealed with it.
      keyGrant:
        req.baseRevision === 0 && req.encryptedKey
          ? { accountId: user.id, wrappedKey: req.encryptedKey }
          : undefined,
    });
  }

  async putFolder(
    user: AuthenticatedUser,
    projectId: string,
    id: string,
    req: PutFolderRequest,
  ): Promise<ProjectEntry> {
    await this.assertOwner(await this.access(user, projectId), user, projectId);
    if (req.encryptedMeta.kid !== id) throw new BadRequestException({ error: 'key_mismatch' });
    return this.write(user, {
      projectId,
      id,
      type: 'folder',
      baseRevision: req.baseRevision,
      encryptedMeta: req.encryptedMeta,
    });
  }

  async putSecret(
    user: AuthenticatedUser,
    projectId: string,
    id: string,
    req: PutSecretRequest,
  ): Promise<ProjectEntry> {
    const access = await this.access(user, projectId);
    if (req.encryptedMeta.kid !== id) throw new BadRequestException({ error: 'key_mismatch' });
    for (const [envId, value] of Object.entries(req.values)) {
      if (value && value.kid !== envId) throw new BadRequestException({ error: 'key_mismatch' });
      // Writing a value needs that environment's key; the server enforces it too.
      if (!access.environments.has(envId)) throw new ForbiddenException({ error: 'no_access' });
    }
    await this.policy.assertSecretWrite(projectId, user.id, Object.keys(req.values));
    return this.write(user, {
      projectId,
      id,
      type: 'secret',
      baseRevision: req.baseRevision,
      encryptedMeta: req.encryptedMeta,
      values: req.values,
    });
  }

  async deleteEntry(
    user: AuthenticatedUser,
    projectId: string,
    type: 'environment' | 'folder' | 'secret',
    id: string,
    baseRevision: number,
  ): Promise<ProjectEntry> {
    const access = await this.access(user, projectId);
    if (type !== 'secret') await this.assertOwner(access, user, projectId);
    else await this.policy.assertSecretWrite(projectId, user.id, []);
    return this.write(user, { projectId, id, type, baseRevision, encryptedMeta: null });
  }

  private async write(
    user: AuthenticatedUser,
    w: Omit<EntryWrite, 'limit' | 'viewer' | 'now'>,
  ): Promise<ProjectEntry> {
    const result = await this.store.writeEntry({
      ...w,
      limit: LIMITS[w.type],
      viewer: user.id,
      now: new Date(),
    });
    if (result.ok) return result.entry;
    switch (result.reason) {
      case 'conflict': {
        const body: EntryConflictResponse = { error: 'conflict', current: result.current };
        throw new ConflictException(body);
      }
      case 'not_found':
        throw new NotFoundException();
      case 'type_mismatch':
        throw new ConflictException({ error: 'type_mismatch' });
      case 'limit':
        throw new BadRequestException({ error: 'limit_reached' });
      case 'unknown_environment':
        throw new BadRequestException({ error: 'unknown_environment' });
    }
  }

  /** Non-members get 404, so project ids can't be probed. */
  private async access(user: AuthenticatedUser, projectId: string): Promise<ProjectAccess> {
    await this.policy.beforeAccess(projectId);
    const access = await this.store.getAccess(projectId, user.id);
    if (!access?.member) throw new NotFoundException();
    return access;
  }

  /** The owner, or (for projects shared with an org) its owners and admins. */
  private async assertOwner(
    access: ProjectAccess,
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void> {
    await this.policy.assertStructure(projectId, user.id, access.ownerId);
  }
}

function toRecord({ row, wrappedKey }: StoredProject, user: AuthenticatedUser): ProjectRecord {
  return {
    id: row.id,
    revision: row.revision,
    encryptedMeta: row.encryptedMeta,
    encryptedKey: wrappedKey,
    owner: row.ownerId === user.id,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

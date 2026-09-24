import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { levelAtLeast } from '@zvault/shared';
import { ACCESS_CLOCK, type Clock } from './clock.js';
import { AccessFacts } from './access.facts.js';
import { holderKey } from './levels.js';

/**
 * Team rules for the projects API. A project that isn't shared with an
 * organization keeps the projects module's own rules (the owner does
 * everything); once shared, these apply on top of holding the keys.
 */
@Injectable()
export class ProjectPolicy {
  constructor(
    private readonly facts: AccessFacts,
    @Inject(ACCESS_CLOCK) private readonly now: Clock,
  ) {}

  /** Drops key grants that lapsed (end dates, removals) before a project is read. */
  async beforeAccess(projectId: string): Promise<void> {
    await this.facts.reconcileProject(projectId, this.now());
  }

  /** Environments, folders and project metadata: the owner, or org owners and admins. */
  async assertStructure(projectId: string, accountId: string, ownerId: string): Promise<void> {
    if (accountId === ownerId) return;
    const project = await this.facts.linkedProject(projectId);
    if (project && (await this.facts.isAdmin(project.orgId, accountId))) return;
    throw new ForbiddenException({ error: 'owner_only' });
  }

  /**
   * Writing a secret needs Edit in every environment whose value it changes,
   * and Edit somewhere for a metadata-only write or a delete.
   */
  async assertSecretWrite(
    projectId: string,
    accountId: string,
    environmentIds: readonly string[],
  ): Promise<void> {
    const project = await this.facts.linkedProject(projectId);
    if (!project || project.ownerId === accountId) return;
    const { byEnv } = await this.facts.projectLevels(project, this.now());
    const levelIn = (envId: string) =>
      byEnv.get(envId)?.get(holderKey('account', accountId)) ?? 'none';
    const ok =
      environmentIds.length > 0
        ? environmentIds.every((id) => levelAtLeast(levelIn(id), 'edit'))
        : [...byEnv.keys()].some((id) => levelAtLeast(levelIn(id), 'edit'));
    if (!ok) throw new ForbiddenException({ error: 'no_access' });
  }
}

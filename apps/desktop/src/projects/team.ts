import type {
  AccessLevel,
  EnvironmentAccess,
  InviteMemberInput,
  OrgDetail,
  OrgRole,
  OrgSummary,
  PrincipalRef,
  ProjectAccessResponse,
} from '@zvault/shared';
import { TeamError, teamError, type TeamApi } from './teamApi.js';

export interface ProjectTeam {
  /** `unshared`: the project is not linked to an organization (the API says 404). */
  status: 'loading' | 'ready' | 'unshared' | 'failed';
  error: string | null;
  access: ProjectAccessResponse | null;
  /** Per environment id; missing while loading or when it failed to load. */
  envs: Record<string, EnvironmentAccess | undefined>;
  org: OrgDetail | null;
}

export interface TeamSnapshot {
  orgsStatus: 'idle' | 'loading' | 'ready' | 'failed';
  orgsError: string | null;
  orgs: OrgSummary[];
  projects: Record<string, ProjectTeam | undefined>;
}

const LOADING: ProjectTeam = { status: 'loading', error: null, access: null, envs: {}, org: null };

/**
 * Team access for the signed-in account: its organizations and, per project,
 * who can reach each environment. Same shape as {@link ProjectsSync}: an
 * immutable snapshot for `useSyncExternalStore`, refreshed after each write.
 *
 * Writes throw; screens turn the error into text with `teamError`.
 */
export class TeamStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: TeamSnapshot = { orgsStatus: 'idle', orgsError: null, orgs: [], projects: {} };

  constructor(
    private readonly api: TeamApi,
    /** This account's sharing public key, for creating or joining an org. */
    private readonly publicKey: () => Promise<string>,
  ) {}

  get = (): TeamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async loadOrgs(): Promise<void> {
    this.set({ orgsStatus: 'loading', orgsError: null });
    try {
      this.set({ orgs: await this.api.listOrgs(), orgsStatus: 'ready' });
    } catch (e) {
      this.set({ orgsStatus: 'failed', orgsError: teamError(e, 'Teams could not be loaded.') });
    }
  }

  /** Loads the access matrix, each environment's grants and the organization. */
  async loadProject(projectId: string): Promise<void> {
    const known = this.snapshot.projects[projectId];
    if (!known || known.status === 'failed') this.setProject(projectId, LOADING);
    try {
      const access = await this.api.projectAccess(projectId);
      const [org, ...envs] = await Promise.all([
        this.api.org(access.orgId),
        ...access.environments.map((e) => this.api.environment(e.id).catch(() => undefined)),
      ]);
      this.setProject(projectId, {
        status: 'ready',
        error: null,
        access,
        org,
        envs: Object.fromEntries(access.environments.map((e, i) => [e.id, envs[i]])),
      });
    } catch (e) {
      if (e instanceof TeamError && e.status === 404) {
        this.setProject(projectId, { ...LOADING, status: 'unshared' });
        if (this.snapshot.orgsStatus === 'idle') void this.loadOrgs();
        return;
      }
      this.setProject(projectId, {
        ...(known ?? LOADING),
        status: 'failed',
        error: teamError(e, 'Access could not be loaded.'),
      });
    }
  }

  async createOrg(name: string): Promise<OrgDetail> {
    const org = await this.api.createOrg(name.trim(), await this.publicKey());
    await this.loadOrgs();
    return org;
  }

  async acceptInvite(orgId: string): Promise<void> {
    await this.api.acceptInvite(orgId, await this.publicKey());
    await this.loadOrgs();
  }

  async linkProject(projectId: string, orgId: string): Promise<void> {
    await this.api.linkProject(projectId, orgId);
    await this.loadProject(projectId);
  }

  /** Sets one principal's level in each of `envIds`. */
  async grant(
    projectId: string,
    principal: PrincipalRef,
    level: AccessLevel,
    envIds: string[],
    expiresAt: string | null = null,
  ): Promise<void> {
    try {
      for (const envId of envIds) {
        await this.api.putGrant(envId, { principal, level, expiresAt });
      }
    } finally {
      await this.loadProject(projectId);
    }
  }

  /** Removes one principal's own grant from each of `envIds`. */
  async revoke(projectId: string, principal: PrincipalRef, envIds: string[]): Promise<void> {
    try {
      for (const envId of envIds) {
        await this.api.deleteGrant(envId, principal).catch((e: unknown) => {
          // Already gone is what we wanted.
          if (!(e instanceof TeamError && e.status === 404)) throw e;
        });
      }
    } finally {
      await this.loadProject(projectId);
    }
  }

  invite(projectId: string, orgId: string, body: InviteMemberInput) {
    return this.orgWrite(projectId, () => this.api.invite(orgId, body));
  }

  changeRole(projectId: string, orgId: string, accountId: string, role: OrgRole) {
    return this.orgWrite(projectId, () => this.api.changeRole(orgId, accountId, role));
  }

  removeMember(projectId: string, orgId: string, accountId: string) {
    return this.orgWrite(projectId, () => this.api.removeMember(orgId, accountId));
  }

  createGroup(projectId: string, orgId: string, name: string) {
    return this.orgWrite(projectId, () => this.api.createGroup(orgId, name.trim()));
  }

  deleteGroup(projectId: string, orgId: string, groupId: string) {
    return this.orgWrite(projectId, () => this.api.deleteGroup(orgId, groupId));
  }

  addToGroup(projectId: string, orgId: string, groupId: string, accountId: string) {
    return this.orgWrite(projectId, () => this.api.addToGroup(orgId, groupId, accountId));
  }

  removeFromGroup(projectId: string, orgId: string, groupId: string, accountId: string) {
    return this.orgWrite(projectId, () => this.api.removeFromGroup(orgId, groupId, accountId));
  }

  removeAgent(projectId: string, orgId: string, agentId: string) {
    return this.orgWrite(projectId, () => this.api.removeAgent(orgId, agentId));
  }

  /** Runs an org change, then reloads the project it was made from. */
  private async orgWrite(projectId: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } finally {
      await this.loadProject(projectId);
    }
  }

  private setProject(projectId: string, state: ProjectTeam): void {
    this.set({ projects: { ...this.snapshot.projects, [projectId]: state } });
  }

  private set(patch: Partial<TeamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

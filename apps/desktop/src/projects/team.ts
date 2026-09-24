import type {
  AccessLevel,
  AccessRequestView,
  EnvironmentAccess,
  InviteMemberInput,
  OrgDetail,
  OrgRole,
  OrgSummary,
  PrincipalRef,
  ProjectAccessResponse,
} from '@zvault/shared';
import type { TeamKeysCore } from './core.js';
import type { ProjectsSnapshot } from './sync.js';
import { TeamError, teamError, type TeamApi } from './teamApi.js';
import {
  environmentValues,
  keyHolders,
  missingRecipients,
  recipientsFor,
  releaseItems,
} from './teamModel.js';

export interface ProjectTeam {
  /** `unshared`: the project is not linked to an organization (the API says 404). */
  status: 'loading' | 'ready' | 'unshared' | 'failed';
  error: string | null;
  access: ProjectAccessResponse | null;
  /** Per environment id; missing while loading or when it failed to load. */
  envs: Record<string, EnvironmentAccess | undefined>;
  /**
   * Access requests per environment id: pending ones for a manager, the
   * account's own otherwise. Missing when they failed to load.
   */
  requests: Record<string, AccessRequestView[] | undefined>;
  org: OrgDetail | null;
}

/** Progress of handing keys to teammates who were given access. */
export interface KeyHandOver {
  /** What is being wrapped right now ("Production"), or null when idle. */
  step: string | null;
  error: string | null;
  /** Keys this device doesn't hold, so another manager has to hand them over. */
  skipped: string[];
}

export interface TeamSnapshot {
  orgsStatus: 'idle' | 'loading' | 'ready' | 'failed';
  orgsError: string | null;
  orgs: OrgSummary[];
  projects: Record<string, ProjectTeam | undefined>;
  /** Per project id; missing until keys were handed over there. */
  handOvers: Record<string, KeyHandOver | undefined>;
}

/** What key work needs from the projects sync: open projects, their sealed values. */
export interface ProjectsSource {
  get(): ProjectsSnapshot;
  pull(projectId: string): Promise<void>;
}

const LOADING: ProjectTeam = {
  status: 'loading',
  error: null,
  access: null,
  envs: {},
  requests: {},
  org: null,
};

/**
 * Team access for the signed-in account: its organizations and, per project,
 * who can reach each environment. Same shape as {@link ProjectsSync}: an
 * immutable snapshot for `useSyncExternalStore`, refreshed after each write.
 *
 * Writes throw; screens turn the error into text with `teamError`.
 */
export class TeamStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: TeamSnapshot = {
    orgsStatus: 'idle',
    orgsError: null,
    orgs: [],
    projects: {},
    handOvers: {},
  };

  constructor(
    private readonly api: TeamApi,
    /** This account's sharing public key, for creating or joining an org. */
    private readonly publicKey: () => Promise<string>,
    /** Wraps, rotates and releases keys in Rust with this account's sharing key. */
    private readonly keys: TeamKeysCore,
    private readonly projects: ProjectsSource,
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
      const ids = access.environments.map((e) => e.id);
      const [org, envs, requests] = await Promise.all([
        this.api.org(access.orgId),
        Promise.all(ids.map((id) => this.api.environment(id).catch(() => undefined))),
        Promise.all(ids.map((id) => this.api.listRequests(id).catch(() => undefined))),
      ]);
      this.setProject(projectId, {
        status: 'ready',
        error: null,
        access,
        org,
        envs: Object.fromEntries(ids.map((id, i) => [id, envs[i]])),
        requests: Object.fromEntries(ids.map((id, i) => [id, requests[i]])),
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

  /**
   * Sets one principal's level in each of `envIds`, then hands the keys to
   * whoever that gave access to, so they can read right away.
   */
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
    await this.handOverKeys(projectId);
  }

  /**
   * Wraps the project key and each environment key this device holds to the
   * members the API lists as still waiting for them. Never throws: progress
   * and errors land in `handOvers`. Returns whether everything went through.
   */
  async handOverKeys(projectId: string): Promise<boolean> {
    const team = this.snapshot.projects[projectId];
    const project = this.projects.get().projects.find((p) => p.id === projectId);
    if (!team?.access || !project || this.snapshot.handOvers[projectId]?.step) return false;
    const toProject = team.access.pendingProjectWraps;
    const toEnvs = team.access.environments.flatMap((e) => {
      const env = team.envs[e.id];
      return env && env.pendingWraps.length > 0 ? [env] : [];
    });
    if (toProject.length === 0 && toEnvs.length === 0) return true;

    const skipped: string[] = [];
    const step = (name: string) =>
      this.setHandOver(projectId, { step: name, error: null, skipped });
    try {
      if (toProject.length > 0) {
        step('project names');
        const body = await this.keys.wrapProjectKey(projectId, toProject);
        await this.api.addProjectWraps(projectId, body);
      }
      for (const env of toEnvs) {
        const local = project.environments.find((e) => e.id === env.environmentId);
        if (!local || local.locked) {
          skipped.push(local?.name ?? 'an environment you can’t read');
          continue;
        }
        step(local.name);
        const body = await this.keys.wrapEnvironmentKey(
          projectId,
          env.environmentId,
          env.keyVersion,
          env.pendingWraps,
        );
        await this.api.addEnvironmentWraps(env.environmentId, body);
      }
      this.setHandOver(projectId, { step: null, error: null, skipped });
      return skipped.length === 0;
    } catch (e) {
      this.setHandOver(projectId, {
        step: null,
        error: teamError(e, 'The keys could not be handed over.'),
        skipped,
      });
      return false;
    } finally {
      await this.loadProject(projectId);
    }
  }

  /**
   * Moves an environment to a fresh key: every value is re-sealed and the key
   * is wrapped only to those who still have access, so anyone removed can't
   * read what is there any more. `me` is this account's id in the org.
   */
  async rotate(projectId: string, environmentId: string, me: string | null): Promise<void> {
    const org = this.snapshot.projects[projectId]?.org;
    if (!org) throw new Error('The organization is still loading. Try again in a moment.');
    // Rotation has to re-seal exactly the values the server holds now.
    await this.projects.pull(projectId);
    const { projects, secrets } = this.projects.get();
    const env = projects
      .find((p) => p.id === projectId)
      ?.environments.find((e) => e.id === environmentId);
    if (!env || env.locked) {
      throw new Error('This device doesn’t hold this environment’s key, so it can’t rotate it.');
    }
    const detail = await this.api.environment(environmentId);
    const values = environmentValues(secrets, projectId, environmentId);
    let recipients = keyHolders(detail, org, me ? [me] : []);
    const send = async () =>
      this.api.rotateEnvironment(
        environmentId,
        await this.keys.rotateEnvironment(
          projectId,
          environmentId,
          detail.keyVersion,
          recipients,
          values,
        ),
      );
    try {
      try {
        await send();
      } catch (e) {
        // The API names holders this device can't see, like the project's
        // owner when someone else rotates. Add them once and try again.
        if (!(e instanceof TeamError && e.status === 422)) throw e;
        const known = new Set(recipients.map((r) => r.accountId));
        const extra = recipientsFor(
          org,
          missingRecipients(e.message).filter((id) => !known.has(id)),
        );
        if (!extra || extra.length === 0) throw e;
        recipients = [...recipients, ...extra];
        await send();
      }
      await this.keys.commitRotation(projectId, environmentId);
      await this.projects.pull(projectId);
    } finally {
      await this.loadProject(projectId);
    }
  }

  /** Seals the requested values to the requester and approves the request. */
  async approve(projectId: string, request: AccessRequestView): Promise<void> {
    try {
      await this.projects.pull(projectId);
      const { projects, secrets } = this.projects.get();
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error('This project is no longer available.');
      const { items, missing } = releaseItems(
        project,
        secrets,
        request.environmentId,
        request.items,
      );
      if (missing.length > 0) {
        throw new Error(`No value to release for ${missing.join(', ')}. Deny it instead.`);
      }
      const release = await this.keys.sealRelease(
        projectId,
        request.id,
        request.requesterPublicKey,
        items,
      );
      await this.api.approveRequest(request.id, release);
    } finally {
      await this.loadProject(projectId);
    }
  }

  async deny(projectId: string, requestId: string): Promise<void> {
    try {
      await this.api.denyRequest(requestId);
    } finally {
      await this.loadProject(projectId);
    }
  }

  /** One value a manager released to this account. Never keep or log it. */
  async releasedValue(request: AccessRequestView, item: string): Promise<string> {
    if (!request.release) throw new Error('This release has expired.');
    const values = await this.keys.openRelease(request.id, request.release);
    const found = values.find((v) => v.item === item);
    if (!found) throw new Error('This value was not released.');
    return found.value;
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

  private setHandOver(projectId: string, state: KeyHandOver): void {
    this.set({ handOvers: { ...this.snapshot.handOvers, [projectId]: state } });
  }

  private setProject(projectId: string, state: ProjectTeam): void {
    this.set({ projects: { ...this.snapshot.projects, [projectId]: state } });
  }

  private set(patch: Partial<TeamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ProjectsSnapshot, ProjectsSync } from './sync.js';
import type { ProjectTeam, TeamSnapshot, TeamStore } from './team.js';

/** The signed-in account's projects; provided by the app shell. */
export const ProjectsContext = createContext<ProjectsSync | null>(null);

export function useProjectsSync(): ProjectsSync {
  const sync = useContext(ProjectsContext);
  if (!sync) throw new Error('useProjectsSync needs a ProjectsContext provider');
  return sync;
}

export function useProjects(): ProjectsSnapshot {
  const sync = useProjectsSync();
  return useSyncExternalStore(sync.subscribe, sync.get);
}

/** Team access (organizations and per-environment grants); provided by the app shell. */
export const TeamContext = createContext<{ store: TeamStore; email: string } | null>(null);

export function useTeamStore(): { store: TeamStore; email: string } {
  const team = useContext(TeamContext);
  if (!team) throw new Error('useTeamStore needs a TeamContext provider');
  return team;
}

export function useTeam(): TeamSnapshot {
  const { store } = useTeamStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One project's team access, loaded when first shown. */
export function useProjectTeam(projectId: string): ProjectTeam | undefined {
  const { store } = useTeamStore();
  const team = useTeam();
  useEffect(() => {
    void store.loadProject(projectId);
  }, [store, projectId]);
  return team.projects[projectId];
}

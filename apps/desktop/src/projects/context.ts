import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ProjectsSnapshot, ProjectsSync } from './sync.js';

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

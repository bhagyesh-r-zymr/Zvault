import { useEffect, useMemo, useState } from 'react';
import { AgentsView } from '../agents/AgentsView.js';
import type { Session } from '../auth.js';
import { Generator } from '../generator/Generator.js';
import { StrengthChecker } from '../generator/StrengthChecker.js';
import { lock, type LockStatus } from '../lock.js';
import { ENV_COLORS, useProjects } from '../projects/model.js';
import { ProjectAccess } from '../projects/ProjectAccess.js';
import { ProjectsView, ProjectTile } from '../projects/ProjectsView.js';
import { API_URL, sharingApi } from '../sharing/api.js';
import { SharingCenter } from '../sharing/SharingCenter.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { VaultApi } from '../vault/api.js';
import { FOCUS_SEARCH_EVENT, VaultScreen } from '../vault/VaultScreen.js';
import { SettingsView, type SettingsSection } from './SettingsView.js';

export type Route =
  | { name: 'vault' }
  | { name: 'project'; projectId: string; envId: string }
  | { name: 'access'; projectId: string }
  | { name: 'agents' }
  | { name: 'sharing' }
  | { name: 'generator' }
  | { name: 'settings'; section: SettingsSection };

const isMac = navigator.platform.toLowerCase().includes('mac');
const MOD = isMac ? '⌘' : 'Ctrl ';

/** The unlocked app: sidebar navigation and the screen it points at. */
export function AppShell(props: {
  session: Session;
  lockStatus: LockStatus | null;
  onLockChanged: () => void;
  onSignOut: () => void;
}) {
  const { session } = props;
  const [route, setRoute] = useState<Route>({ name: 'vault' });
  const [openProjects, setOpenProjects] = useState<string[]>(['zvault']);
  const { projects } = useProjects();

  const vaultApi = useMemo(
    () => new VaultApi({ baseUrl: API_URL, accessToken: () => session.token }),
    [session.token],
  );
  const sharing = useMemo(
    () => sharingApi(() => ({ authorization: `Bearer ${session.token}` })),
    [session.token],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setRoute({ name: 'vault' });
        // Let the vault mount before asking it to focus.
        setTimeout(() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT)), 0);
      } else if (key === 'l') {
        e.preventDefault();
        void lock.lockNow();
      } else if (key === ',') {
        e.preventDefault();
        setRoute({ name: 'settings', section: 'security' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav = (target: Route, icon: IconName, label: string, extra?: React.ReactNode) => {
    const current =
      route.name === target.name &&
      (target.name !== 'access' ||
        (route.name === 'access' && route.projectId === target.projectId));
    return (
      <button
        type="button"
        className="nav-item"
        aria-current={current ? 'page' : undefined}
        onClick={() => setRoute(target)}
      >
        <Icon name={icon} size={15} />
        <span className="label">{label}</span>
        {extra}
      </button>
    );
  };

  const toggleProject = (id: string) =>
    setOpenProjects((open) => (open.includes(id) ? open.filter((x) => x !== id) : [...open, id]));

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Sidebar">
        <div className="sidebar-account">
          <span className="brand-mark" style={{ width: 30, height: 30, borderRadius: 9 }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 6h14L5 18h14" />
            </svg>
          </span>
          <span className="who">
            <strong>Zvault</strong>
            <span className="truncate">{session.email}</span>
          </span>
        </div>

        <button
          type="button"
          className="search-trigger"
          onClick={() => {
            setRoute({ name: 'vault' });
            setTimeout(() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT)), 0);
          }}
        >
          <Icon name="search" size={14} />
          <span>Search</span>
          <kbd>{MOD}K</kbd>
        </button>

        {nav({ name: 'vault' }, 'items', 'Personal')}

        <div className="nav-section">
          <span className="eyebrow">Projects</span>
          <span className="pill iris" style={{ height: 18, fontSize: 10, padding: '0 6px' }}>
            Preview
          </span>
        </div>
        {projects.map((p) => {
          const open = openProjects.includes(p.id);
          return (
            <div key={p.id} style={{ display: 'contents' }}>
              <button
                type="button"
                className="nav-item"
                aria-expanded={open}
                onClick={() => toggleProject(p.id)}
              >
                <Icon
                  name={open ? 'chevronDown' : 'chevronRight'}
                  size={11}
                  strokeWidth={3}
                  className="nav-caret"
                />
                <ProjectTile project={p} />
                <span className="label" style={{ color: 'var(--text)' }}>
                  {p.name}
                </span>
              </button>
              {open && (
                <div className="nav-tree">
                  {p.environments.map((env) => (
                    <button
                      key={env.id}
                      type="button"
                      className="nav-item sub"
                      aria-current={
                        route.name === 'project' &&
                        route.projectId === p.id &&
                        route.envId === env.id
                          ? 'page'
                          : undefined
                      }
                      onClick={() => setRoute({ name: 'project', projectId: p.id, envId: env.id })}
                    >
                      <span className="dot" style={{ background: ENV_COLORS[env.color] }} />
                      <span className="label">{env.name}</span>
                      {env.restricted && (
                        <Icon name="lock" size={12} className="muted" aria-label="Managers only" />
                      )}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="nav-item sub"
                    aria-current={
                      route.name === 'access' && route.projectId === p.id ? 'page' : undefined
                    }
                    onClick={() => setRoute({ name: 'access', projectId: p.id })}
                  >
                    <Icon name="people" size={13} />
                    <span className="label">Access</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <div className="nav-section">
          <span className="eyebrow">Access</span>
        </div>
        {nav({ name: 'agents' }, 'agent', 'Agents', <span className="count">1</span>)}
        {nav({ name: 'sharing' }, 'share', 'Sharing')}

        <div className="nav-section">
          <span className="eyebrow">Tools</span>
        </div>
        {nav({ name: 'generator' }, 'wand', 'Password generator')}

        <div className="sidebar-foot">
          {nav({ name: 'settings', section: 'security' }, 'settings', 'Settings')}
          <button type="button" className="lock-button" onClick={() => void lock.lockNow()}>
            <Icon name="lock" size={13} strokeWidth={2.2} />
            <span>Lock now</span>
            <kbd className="kbd" style={{ color: 'inherit' }}>
              {MOD}L
            </kbd>
          </button>
        </div>
      </nav>

      <main className="main">
        {route.name === 'vault' && <VaultScreen api={vaultApi} sharing={sharing} />}
        {route.name === 'project' && (
          <ProjectsView
            key={route.projectId}
            projectId={route.projectId}
            envId={route.envId}
            onEnvChange={(envId) => setRoute({ ...route, envId })}
            onOpenAccess={() => setRoute({ name: 'access', projectId: route.projectId })}
          />
        )}
        {route.name === 'access' && <ProjectAccess projectId={route.projectId} />}
        {route.name === 'agents' && <AgentsView />}
        {route.name === 'sharing' && <SharingCenter api={sharing} />}
        {route.name === 'generator' && (
          <div className="page">
            <div className="page-inner">
              <div className="page-head">
                <div>
                  <h1>Password generator</h1>
                  <p>
                    Every character is picked in the secure core from the system&apos;s random
                    source.
                  </p>
                </div>
              </div>
              <Generator />
              <StrengthChecker />
            </div>
          </div>
        )}
        {route.name === 'settings' && (
          <SettingsView
            session={session}
            section={route.section}
            onSection={(section) => setRoute({ name: 'settings', section })}
            lockStatus={props.lockStatus}
            onLockChanged={props.onLockChanged}
            onSignOut={props.onSignOut}
          />
        )}
      </main>
    </div>
  );
}

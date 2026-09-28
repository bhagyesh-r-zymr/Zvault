import type { ActivityEvent } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { ErrorLine } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { describeEvent, KIND_OF, type ActivityKind } from './activity.js';
import { ApiError, ForbiddenError, type ProjectsApi } from './api.js';
import { useProjects } from './context.js';
import { EnvDot, ProjectTile } from './ProjectsView.js';
import './activity.css';

const KINDS: { value: ActivityKind | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'use', label: 'Used and shared' },
  { value: 'change', label: 'Changes' },
  { value: 'access', label: 'Access' },
];

const ICON: Partial<Record<ActivityEvent['action'], IconName>> = {
  'secret.viewed': 'eye',
  'secret.copied': 'copy',
  'secret.shared': 'share',
  'agent.used': 'agent',
  'agent.denied': 'agent',
  'secret.created': 'plus',
  'secret.updated': 'edit',
  'secret.deleted': 'trash',
  'secret.purged': 'trash',
  'environment.created': 'settings',
  'environment.updated': 'settings',
  'environment.deleted': 'settings',
  'folder.created': 'folder',
  'folder.updated': 'folder',
  'folder.deleted': 'folder',
  'project.updated': 'edit',
  'project.linked': 'people',
  'grant.changed': 'people',
  'grant.removed': 'people',
  'key.rotated': 'refresh',
  'request.created': 'lock',
  'request.approved': 'shieldCheck',
  'request.denied': 'lock',
};

type State =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; events: ActivityEvent[]; hasMore: boolean; more: boolean };

/**
 * A project's team activity log. The server sends ids; names of secrets and
 * environments come from this Mac's decrypted copy of the project.
 */
export function ProjectActivity(props: {
  projectId: string;
  api: Pick<ProjectsApi, 'activity'>;
  email: string;
  onOpenSecret?: (secretId: string, envId: string) => void;
}) {
  const { projects, secrets } = useProjects();
  const project = projects.find((p) => p.id === props.projectId);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [kind, setKind] = useState<ActivityKind | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  const { api, projectId } = props;

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await api.activity(projectId);
      setState({ status: 'ready', events: page.events, hasMore: page.hasMore, more: false });
    } catch (e) {
      setState(failure(e));
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.status !== 'ready') return;
    setState({ ...state, more: true });
    try {
      const page = await api.activity(projectId, { before: state.events.at(-1)!.seq });
      setState({
        status: 'ready',
        events: [...state.events, ...page.events],
        hasMore: page.hasMore,
        more: false,
      });
    } catch (e) {
      setState(failure(e));
    }
  };

  if (!project) {
    return (
      <div className="empty">
        <Icon name="history" size={32} />
        <span>This project is no longer available.</span>
      </div>
    );
  }

  const shown =
    state.status === 'ready'
      ? state.events.filter(
          (e) =>
            (kind === null || KIND_OF[e.action] === kind) &&
            (envId === null || e.environmentId === envId),
        )
      : [];
  const days = groupByDay(shown);

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-head">
          <ProjectTile project={project} size="large" />
          <div>
            <h1>{project.name} · Activity</h1>
            <p>
              Who used, shared or changed what, and who gave access. The log holds references only,
              never values, and names are decrypted on this Mac.
            </p>
          </div>
          <button type="button" onClick={() => void load()} disabled={state.status === 'loading'}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>

        <div className="activity-filters">
          <div className="env-filter" role="group" aria-label="Show">
            {KINDS.map((k) => (
              <button
                key={k.label}
                type="button"
                className="chip"
                aria-pressed={kind === k.value}
                onClick={() => setKind(k.value)}
              >
                {k.label}
              </button>
            ))}
          </div>
          {project.environments.length > 1 && (
            <div className="env-filter" role="group" aria-label="Environment">
              {project.environments.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="chip"
                  aria-pressed={envId === e.id}
                  onClick={() => setEnvId(envId === e.id ? null : e.id)}
                >
                  <EnvDot env={e} />
                  {e.short}
                </button>
              ))}
            </div>
          )}
        </div>

        {state.status === 'loading' && (
          <div className="empty" aria-busy="true">
            <span className="spinner" />
            Loading activity…
          </div>
        )}
        {state.status === 'forbidden' && (
          <div className="empty">
            <Icon name="lock" size={30} />
            <strong>Only managers can see the activity log</strong>
            <span>
              The project owner, organization admins and people who manage an environment can see
              who did what in {project.name}.
            </span>
          </div>
        )}
        {state.status === 'failed' && <ErrorLine error={state.error} />}
        {state.status === 'ready' && shown.length === 0 && (
          <div className="empty">
            <Icon name="history" size={30} />
            <span>
              {state.events.length === 0
                ? 'Nothing has happened here yet. Views, copies, shares and changes will show up here.'
                : 'Nothing matches these filters.'}
            </span>
          </div>
        )}

        {days.map(({ label, events }) => (
          <section key={label}>
            <div className="section-label">
              <span>{label}</span>
            </div>
            <ul className="panel rows activity-log">
              {events.map((e) => {
                const d = describeEvent(e, { project, secrets, meEmail: props.email });
                const env = project.environments.find((x) => x.id === e.environmentId);
                const secret = secrets.find(
                  (s) => s.projectId === project.id && s.id === e.targetId,
                );
                const openable =
                  props.onOpenSecret && secret && env && KIND_OF[e.action] !== 'access';
                return (
                  <li key={e.seq} className="row activity-row" data-tone={d.tone}>
                    <span className="activity-icon" data-kind={d.kind}>
                      <Icon name={ICON[e.action] ?? 'history'} size={14} />
                    </span>
                    <span className="row-main">
                      <span className="activity-line">
                        <span className="actor">{d.who}</span> {d.what}{' '}
                        {d.subject &&
                          (openable ? (
                            <button
                              type="button"
                              className="link subject mono"
                              onClick={() => props.onOpenSecret!(secret.id, env.id)}
                            >
                              {d.subject}
                            </button>
                          ) : (
                            <span className={secret ? 'subject mono' : 'subject'}>{d.subject}</span>
                          ))}
                        {d.where && <span className="where"> {d.where}</span>}
                      </span>
                    </span>
                    {env && (
                      <span className="chip env-chip" title={env.name}>
                        <EnvDot env={env} />
                        {env.short}
                      </span>
                    )}
                    <time className="muted" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                      {clock(e.at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {state.status === 'ready' && state.hasMore && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button type="button" disabled={state.more} onClick={() => void loadMore()}>
              {state.more ? 'Loading…' : 'Show older activity'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function failure(e: unknown): State {
  if (e instanceof ForbiddenError || (e instanceof ApiError && e.status === 403)) {
    return { status: 'forbidden' };
  }
  if (e instanceof ApiError && e.status === 404) {
    return { status: 'failed', error: 'This project is no longer available.' };
  }
  return { status: 'failed', error: e instanceof Error ? e.message : 'Activity could not load.' };
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Today", "Yesterday", then dates, newest first. */
export function groupByDay(
  events: readonly ActivityEvent[],
  now = new Date(),
): { label: string; events: ActivityEvent[] }[] {
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = dayOf(now);
  const out: { label: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const at = new Date(e.at);
    const diff = Math.round((today - dayOf(at)) / 86_400_000);
    const label =
      diff === 0
        ? 'Today'
        : diff === 1
          ? 'Yesterday'
          : at.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              ...(at.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
            });
    const last = out.at(-1);
    if (last?.label === label) last.events.push(e);
    else out.push({ label, events: [e] });
  }
  return out;
}

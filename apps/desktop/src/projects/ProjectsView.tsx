import { useMemo, useState } from 'react';
import { CopyButton, ErrorLine, SecretText } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { useProjects, useProjectsSync, useProjectTeam, useTeamStore } from './context.js';
import {
  secretRef,
  valueSource,
  type Environment,
  type Folder,
  type Project,
  type ProjectSecret,
} from './model.js';
import { NewSecretSheet } from './NewSecretSheet.js';
import type { ProjectTeam } from './team.js';
import { LEVEL_LABELS, buildMatrix, whoCanUse } from './teamModel.js';
import './projects.css';

export function EnvDot({ env }: { env: Pick<Environment, 'color'> }) {
  return <span className="dot" style={{ background: env.color }} />;
}

export function ProjectTile({
  project,
  size = 'small',
}: {
  project: Pick<Project, 'name' | 'tile'>;
  size?: 'small' | 'large';
}) {
  return (
    <span
      className={`tile ${size}`}
      style={{ background: project.tile.bg, color: project.tile.fg, borderColor: project.tile.bg }}
      aria-hidden="true"
    >
      {project.name[0]}
    </span>
  );
}

export function PreviewNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="preview-note">
      <strong>Preview</strong>
      <span>{children}</span>
    </p>
  );
}

/** One project's secrets in one environment, grouped by folder. */
export function ProjectsView(props: {
  projectId: string;
  envId: string;
  onEnvChange: (envId: string) => void;
  onOpenProject: (projectId: string, envId: string) => void;
  onOpenAccess: () => void;
}) {
  const { projects, secrets, status } = useProjects();
  const team = useProjectTeam(props.projectId);
  const project = projects.find((p) => p.id === props.projectId);
  const env = project?.environments.find((e) => e.id === props.envId) ?? project?.environments[0];

  const [selected, setSelected] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const inProject = useMemo(
    () => secrets.filter((s) => s.projectId === props.projectId),
    [secrets, props.projectId],
  );
  const allTags = useMemo(() => [...new Set(inProject.flatMap((s) => s.tags))].sort(), [inProject]);

  if (!project || !env) {
    return (
      <div className="empty">
        <Icon name="folder" size={32} />
        <span>
          {status === 'loading'
            ? 'Opening project…'
            : !project
              ? 'This project is no longer available.'
              : 'This project has no environments yet.'}
        </span>
      </div>
    );
  }

  // Values of a locked environment can't be seen, so list every secret there.
  const visible = inProject
    .filter((s) => env.locked || valueSource(project, s, env.id))
    .filter((s) => tags.every((t) => s.tags.includes(t)));

  const folders = project.folders.filter((f) => visible.some((s) => s.folder?.id === f.id));
  const loose = visible.filter((s) => !s.folder);
  const current = visible.find((s) => s.id === selected) ?? visible[0] ?? null;

  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const row = (s: ProjectSecret, nested: boolean) => (
    <button
      key={s.id}
      type="button"
      className={nested ? 'list-item nested' : 'list-item'}
      aria-current={current?.id === s.id}
      onClick={() => setSelected(s.id)}
    >
      <span className="tile" style={{ width: 32, height: 32, borderRadius: 9 }}>
        <Icon name="key" size={15} />
      </span>
      <span className="row-main">
        <span className="row-title truncate">{s.name}</span>
        <span className="row-sub mono truncate" style={{ fontSize: 11 }}>
          {s.key}
        </span>
      </span>
    </button>
  );

  const folderGroup = (folder: Folder) => {
    const open = !closed.includes(folder.id);
    const items = visible.filter((s) => s.folder?.id === folder.id);
    return (
      <div key={folder.id} style={{ display: 'contents' }}>
        <button
          type="button"
          className="list-folder"
          aria-expanded={open}
          onClick={() => setClosed(toggle(closed, folder.id))}
        >
          <Icon
            name={open ? 'chevronDown' : 'chevronRight'}
            size={11}
            strokeWidth={3}
            className="nav-caret"
          />
          <Icon name="folder" size={16} className="secondary" />
          <span className="label">{folder.name}</span>
          <span className="n muted">{items.length}</span>
        </button>
        {open && items.map((s) => row(s, true))}
      </div>
    );
  };

  return (
    <div className="split">
      <section className="list-pane" aria-label={`${project.name} ${env.name}`}>
        <div className="list-head">
          <div className="title-row">
            <span className="crumb truncate">
              {project.name}
              <span className="sep">/</span>
              <strong>{env.name}</strong>
            </span>
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} strokeWidth={2.4} />
              New
            </button>
          </div>
          <div className="seg" role="tablist" aria-label="Environment">
            {project.environments.map((e) => (
              <button
                key={e.id}
                type="button"
                role="tab"
                aria-selected={e.id === env.id}
                onClick={() => {
                  props.onEnvChange(e.id);
                  setSelected(null);
                }}
              >
                {e.id === env.id && <EnvDot env={e} />}
                {e.short}
                {e.locked && <Icon name="lock" size={11} aria-label="No access" />}
              </button>
            ))}
          </div>
          {allTags.length > 0 && (
            <div className="tags" aria-label="Filter by tag">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="chip"
                  aria-pressed={tags.includes(t)}
                  onClick={() => setTags(toggle(tags, t))}
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="list-body">
          {folders.map(folderGroup)}
          {loose.map((s) => row(s, false))}
          {visible.length === 0 && (
            <div className="empty">
              <Icon name="key" size={28} />
              <span>
                Nothing in {env.name}
                {tags.length > 0 && ' with these tags'} yet.
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="detail-pane" aria-label="Secret details">
        {current ? (
          <SecretDetail
            key={`${current.id}:${env.id}`}
            project={project}
            env={env}
            secret={current}
            team={team}
            onEnvChange={props.onEnvChange}
            onOpenAccess={props.onOpenAccess}
          />
        ) : (
          <div className="empty">
            <Icon name="folder" size={32} />
            <span>Select a secret, or add one with New.</span>
          </div>
        )}
      </section>

      {creating && (
        <NewSecretSheet
          project={project}
          onClose={() => setCreating(false)}
          onCreated={({ projectId, secretId, envIds }) => {
            setCreating(false);
            setSelected(secretId);
            // Show the new secret where it has a value.
            if (projectId !== project.id) props.onOpenProject(projectId, envIds[0]!);
            else if (!env.locked && !envIds.includes(env.id)) props.onEnvChange(envIds[0]!);
          }}
        />
      )}
    </div>
  );
}

function SecretDetail(props: {
  project: Project;
  env: Environment;
  secret: ProjectSecret;
  team: ProjectTeam | undefined;
  onEnvChange: (envId: string) => void;
  onOpenAccess: () => void;
}) {
  const { project, env, secret } = props;
  const sync = useProjectsSync();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = env.locked ? null : valueSource(project, secret, env.id);
  const sourceEnv = project.environments.find((e) => e.id === source);

  const open = () => sync.openValue(project.id, secret.id, source!);

  const reveal = async () => {
    if (revealed !== null) return setRevealed(null);
    setError(null);
    try {
      setRevealed(await open());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This value could not be decrypted.');
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await sync.deleteSecret(project.id, secret.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This secret could not be deleted.');
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const statusOf = (e: Environment) => {
    if (e.id === env.id) return 'viewing';
    if (e.locked) return 'no access';
    const from = valueSource(project, secret, e.id);
    if (!from) return 'not set';
    if (from !== e.id) {
      return `same as ${project.environments.find((x) => x.id === from)?.name ?? 'another'}`;
    }
    return 'set';
  };

  return (
    <>
      <div className="detail-bar">
        <span className="truncate">
          {project.name} / {env.name}
          {secret.folder && ` / ${secret.folder.name}`}
        </span>
      </div>
      <div className="detail-body">
        <div className="item-head">
          <span className="tile large">
            <Icon name="key" size={24} />
          </span>
          <div>
            <h1>{secret.name}</h1>
            <div className="tags">
              <span className="pill" style={{ height: 22, color: env.color }}>
                <EnvDot env={env} />
                {env.name}
              </span>
              {secret.tags.map((t) => (
                <span key={t} className="chip">
                  #{t}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="section-label">
            <span>Value in each environment</span>
          </div>
          <div className="env-cards">
            {project.environments.map((e) => (
              <button
                key={e.id}
                type="button"
                className="choice"
                aria-pressed={e.id === env.id}
                onClick={() => props.onEnvChange(e.id)}
              >
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <EnvDot env={e} />
                  {e.name}
                </strong>
                <span>{statusOf(e)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel rows">
          <div className="row">
            <div className="row-main">
              <span className="row-label">
                {secret.key}
                {sourceEnv && sourceEnv.id !== env.id && ` · same as ${sourceEnv.name}`}
              </span>
              {env.locked ? (
                <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="lock" size={13} />
                  You don&apos;t have access to {env.name} values.
                </span>
              ) : source ? (
                <SecretText value={revealed ?? ''} masked={revealed === null} />
              ) : (
                <span className="muted">Not set in {env.name}.</span>
              )}
            </div>
            {source && (
              <>
                <button type="button" className="small" onClick={() => void reveal()}>
                  {revealed !== null ? 'Hide' : 'Reveal'}
                </button>
                <CopyButton value={open} />
              </>
            )}
          </div>
        </div>
        {secret.note && (
          <div className="panel panel-pad">
            <div className="row-label" style={{ marginBottom: 6 }}>
              note
            </div>
            <p className="notes">{secret.note}</p>
          </div>
        )}

        {source && (
          <div>
            <div className="section-label">
              <span>Use it from the terminal</span>
            </div>
            <div className="panel panel-pad mono ref-box">
              zv run --env {secret.key}=
              <span className="iris">{secretRef(project, env, secret)}</span> -- npm start
            </div>
          </div>
        )}

        <div
          className="panel panel-pad"
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div className="section-label" style={{ margin: 0 }}>
            <span>
              Who can use {project.name} / {env.name}
            </span>
            <button
              type="button"
              className="link"
              style={{ fontSize: 12 }}
              onClick={props.onOpenAccess}
            >
              Manage access
            </button>
          </div>
          <WhoCanUse team={props.team} project={project} env={env} />
        </div>

        <ErrorLine error={error} />
        <div className="actions" style={{ marginTop: 'auto', justifyContent: 'flex-end' }}>
          {confirmDelete ? (
            <>
              <span className="secondary" style={{ alignSelf: 'center' }}>
                Delete “{secret.name}” from every environment?
              </span>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** The real grants in one environment, from the project's team access. */
function WhoCanUse({
  team,
  project,
  env,
}: {
  team: ProjectTeam | undefined;
  project: Project;
  env: Environment;
}) {
  const { email } = useTeamStore();
  if (!team || team.status === 'loading') return <span className="muted">Loading…</span>;
  if (team.status === 'failed') return <span className="muted">{team.error}</span>;
  if (team.status === 'unshared' || !team.access) {
    return (
      <div className="tags">
        <span className="pill">
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>You</span>
          {env.locked ? 'no access' : project.owner ? 'owner' : 'edit'}
        </span>
        <span className="hint">Not shared with a team.</span>
      </div>
    );
  }
  const users = whoCanUse(
    buildMatrix({ access: team.access, envs: team.envs, org: team.org, meEmail: email }),
    env.id,
  );
  if (users.length === 0) {
    return <span className="muted">Nobody has a grant in {env.name} yet.</span>;
  }
  return (
    <div className="tags">
      {users.map((u) => (
        <span key={u.key} className={u.level === 'needs_approval' ? 'pill attn' : 'pill'}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{u.you ? 'You' : u.name}</span>
          {u.type === 'group' && 'group · '}
          {u.type === 'agent' && 'agent · '}
          {LEVEL_LABELS[u.level].toLowerCase()}
        </span>
      ))}
    </div>
  );
}

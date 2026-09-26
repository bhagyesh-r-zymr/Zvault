import { secretSharePayload, type SharedItemPayload } from '@zvault/shared';
import { useMemo, useState } from 'react';
import type { SharingApi } from '../sharing/api.js';
import { ShareItem } from '../sharing/ShareItem.js';
import { CopyButton, ErrorLine, SecretText, Sheet } from '../ui/controls.js';
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
import { EnvironmentSheet } from './EnvironmentsView.js';
import { NewSecretSheet } from './NewSecretSheet.js';
import { SecretHistory } from './SecretHistory.js';
import type { ProjectTeam } from './team.js';
import {
  LEVEL_LABELS,
  buildMatrix,
  canEditEnv,
  isOrgAdmin,
  levelAttr,
  secretAccess,
} from './teamModel.js';
import './projects.css';

export function EnvDot({ env, hollow }: { env: Pick<Environment, 'color'>; hollow?: boolean }) {
  return hollow ? (
    <span className="dot hollow" style={{ color: env.color }} />
  ) : (
    <span className="dot" style={{ background: env.color }} />
  );
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

/**
 * One project's secrets. The list can be narrowed to one environment; the
 * open secret shows its value in `envId` and who can use it.
 */
export function ProjectsView(props: {
  projectId: string;
  envId: string;
  onEnvChange: (envId: string) => void;
  onOpenProject: (projectId: string, envId: string) => void;
  onOpenAccess: () => void;
  /** Absent in previews; hides Share. */
  sharing?: SharingApi;
}) {
  const { projects, secrets, status } = useProjects();
  const team = useProjectTeam(props.projectId);
  const project = projects.find((p) => p.id === props.projectId);
  const env = project?.environments.find((e) => e.id === props.envId) ?? project?.environments[0];

  const [selected, setSelected] = useState<string | null>(null);
  // `null` lists every secret in the project.
  const [only, setOnly] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [creatingEnv, setCreatingEnv] = useState(false);

  const inProject = useMemo(
    () => secrets.filter((s) => s.projectId === props.projectId),
    [secrets, props.projectId],
  );
  const allTags = useMemo(() => [...new Set(inProject.flatMap((s) => s.tags))].sort(), [inProject]);

  if (project && !env && status !== 'loading') {
    const canManage = project.owner || isOrgAdmin(team?.org ?? null);
    return (
      <>
        <div className="empty">
          <Icon name="folder" size={32} />
          <strong>{project.name} has no environments yet</strong>
          <span>
            {canManage
              ? 'Create one to start adding secrets, such as Development or Production.'
              : 'Ask the project owner or an admin to add one.'}
          </span>
          {canManage && (
            <button type="button" className="primary" onClick={() => setCreatingEnv(true)}>
              <Icon name="plus" size={13} strokeWidth={2.4} />
              Create environment
            </button>
          )}
        </div>
        {creatingEnv && (
          <EnvironmentSheet
            project={project}
            env={null}
            onClose={() => setCreatingEnv(false)}
            onSaved={(envId) => {
              setCreatingEnv(false);
              props.onEnvChange(envId);
            }}
          />
        )}
      </>
    );
  }
  if (!project || !env) {
    return (
      <div className="empty">
        <Icon name="folder" size={32} />
        <span>
          {status === 'loading' ? 'Opening project…' : 'This project is no longer available.'}
        </span>
      </div>
    );
  }

  const filterEnv = project.environments.find((e) => e.id === only) ?? null;
  // Values of a locked environment can't be seen, so list every secret there.
  const visible = inProject
    .filter((s) => !filterEnv || filterEnv.locked || valueSource(project, s, filterEnv.id))
    .filter((s) => tags.every((t) => s.tags.includes(t)));

  const folders = project.folders.filter((f) => visible.some((s) => s.folder?.id === f.id));
  const loose = visible.filter((s) => !s.folder);
  const current = visible.find((s) => s.id === selected) ?? visible[0] ?? null;

  const canEdit = canEditEnv(project, team, env.id);

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
      <Coverage project={project} secret={s} />
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
      <section className="list-pane" aria-label={`${project.name} secrets`}>
        <div className="list-head">
          <div className="title-row">
            <span className="list-title">
              <ProjectTile project={project} />
              <h2 className="truncate">{project.name}</h2>
            </span>
            {canEdit ? (
              <button type="button" className="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={13} strokeWidth={2.4} />
                New
              </button>
            ) : (
              <span className="pill" title={`You can use ${env.name} but not change it`}>
                <Icon name="lock" size={11} />
                View only
              </span>
            )}
          </div>
          <div className="env-filter" role="group" aria-label="Show secrets in">
            <button
              type="button"
              className="chip"
              aria-pressed={only === null}
              onClick={() => setOnly(null)}
            >
              All
            </button>
            {project.environments.map((e) => (
              <button
                key={e.id}
                type="button"
                className="chip"
                aria-pressed={only === e.id}
                title={e.locked ? `You don't have access to ${e.name}` : `Secrets set in ${e.name}`}
                onClick={() => {
                  setOnly(only === e.id ? null : e.id);
                  props.onEnvChange(e.id);
                }}
              >
                <EnvDot env={e} />
                {e.short}
                {e.locked && <Icon name="lock" size={10} aria-label="No access" />}
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
                {filterEnv ? `Nothing in ${filterEnv.name}` : 'No secrets'}
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
            canEdit={canEdit}
            onEnvChange={props.onEnvChange}
            onOpenAccess={props.onOpenAccess}
            {...(props.sharing && { sharing: props.sharing })}
          />
        ) : (
          <div className="empty">
            <Icon name="folder" size={32} />
            <span>{canEdit ? 'Select a secret, or add one with New.' : 'Select a secret.'}</span>
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
            else {
              if (only && !envIds.includes(only)) setOnly(null);
              if (!env.locked && !envIds.includes(env.id)) props.onEnvChange(envIds[0]!);
            }
          }}
        />
      )}
    </div>
  );
}

/** One dot per environment: filled where the secret has a value. */
function Coverage({ project, secret }: { project: Project; secret: ProjectSecret }) {
  const label = project.environments
    .map((e) => {
      if (e.locked) return `${e.name}: no access`;
      return `${e.name}: ${valueSource(project, secret, e.id) ? 'set' : 'not set'}`;
    })
    .join(', ');
  return (
    <span className="coverage" title={label} aria-label={label}>
      {project.environments.map((e) => (
        <EnvDot key={e.id} env={e} hollow={e.locked || !valueSource(project, secret, e.id)} />
      ))}
    </span>
  );
}

function SecretDetail(props: {
  project: Project;
  env: Environment;
  secret: ProjectSecret;
  team: ProjectTeam | undefined;
  /** Whether this account can change secrets in `env`; hides Delete when not. */
  canEdit: boolean;
  onEnvChange: (envId: string) => void;
  onOpenAccess: () => void;
  sharing?: SharingApi;
}) {
  const { project, env, secret, sharing } = props;
  const sync = useProjectsSync();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [share, setShare] = useState<{ envId: string; payload: SharedItemPayload } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = env.locked ? null : valueSource(project, secret, env.id);
  const sourceEnv = project.environments.find((e) => e.id === source);
  // Environments whose value this account can open, for sharing.
  const readable = project.environments.filter(
    (e) => !e.locked && valueSource(project, secret, e.id),
  );

  const open = (envId = env.id) =>
    sync.openValue(project.id, secret.id, valueSource(project, secret, envId)!);

  const reveal = async () => {
    if (revealed !== null) return setRevealed(null);
    setError(null);
    try {
      setRevealed(await open());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This value could not be decrypted.');
    }
  };

  // Only someone holding an environment's key (Use or higher) can open the
  // value, so only they get Share. It is encrypted on this Mac before it leaves.
  const startShare = async (envId: string) => {
    setError(null);
    try {
      const shared = project.environments.find((e) => e.id === envId)!;
      setShare({
        envId,
        payload: secretSharePayload({
          name: secret.name,
          key: secret.key,
          value: await open(envId),
          note: secret.note,
          project: project.name,
          environment: shared.name,
        }),
      });
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
    if (e.locked) return `${e.name}: no access`;
    const from = valueSource(project, secret, e.id);
    if (!from) return `${e.name}: not set`;
    if (from !== e.id) {
      return `${e.name}: same as ${project.environments.find((x) => x.id === from)?.name ?? 'another'}`;
    }
    return `${e.name}: set`;
  };

  const command = `zv run --env ${secret.key}=${secretRef(project, env, secret)} -- npm start`;
  const sharedEnv = project.environments.find((e) => e.id === share?.envId);

  return (
    <>
      <div className="detail-bar">
        <span className="truncate">
          {project.name} / Secrets
          {secret.folder && ` / ${secret.folder.name}`}
        </span>
        <div className="bar-actions">
          {sharing && readable.length > 0 && (
            <button
              type="button"
              className="small primary"
              onClick={() => void startShare(source ? env.id : readable[0]!.id)}
            >
              <Icon name="share" size={13} /> Share
            </button>
          )}
          <button type="button" className="small ghost" onClick={() => setHistoryOpen(true)}>
            <Icon name="history" size={13} /> History
          </button>
          {props.canEdit && (
            <button
              type="button"
              className="small ghost"
              aria-label="Delete"
              title="Move to Trash"
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="detail-body">
        <div className="item-head">
          <span className="tile large">
            <Icon name="key" size={24} />
          </span>
          <div>
            <h1>{secret.name}</h1>
            <div className="tags">
              <span className="mono muted" style={{ fontSize: 12 }}>
                {secret.key}
              </span>
              {secret.tags.map((t) => (
                <span key={t} className="chip">
                  #{t}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="env-switch">
          <span className="muted">Value in</span>
          <div className="seg" role="tablist" aria-label="Environment">
            {project.environments.map((e) => {
              const set = !e.locked && valueSource(project, secret, e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={e.id === env.id}
                  title={statusOf(e)}
                  data-unset={set ? undefined : 'true'}
                  onClick={() => props.onEnvChange(e.id)}
                >
                  <EnvDot env={e} hollow={!set} />
                  {e.short}
                  {e.locked && <Icon name="lock" size={10} aria-label="No access" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel value-card">
          <span className="row-label">
            {secret.key} · {env.name}
            {sourceEnv && sourceEnv.id !== env.id && ` · same as ${sourceEnv.name}`}
          </span>
          <div className="value-line">
            <div className="value-text">
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
              <div className="value-actions">
                <button type="button" className="small" onClick={() => void reveal()}>
                  <Icon name={revealed !== null ? 'eyeOff' : 'eye'} size={13} />
                  {revealed !== null ? 'Hide' : 'Reveal'}
                </button>
                <CopyButton value={() => open()} className="small primary" />
              </div>
            )}
          </div>
          {secret.note && <p className="notes">{secret.note}</p>}
        </div>

        <div className="panel access-card">
          <div className="access-head">
            <h3>Who can use it</h3>
            <button type="button" className="small" onClick={props.onOpenAccess}>
              <Icon name="people" size={13} /> Manage access
            </button>
          </div>
          <SecretAccessList team={props.team} project={project} env={env} />
        </div>

        {source && (
          <div className="command-pill">
            <span className="muted">Terminal</span>
            <span className="mono truncate">
              zv run --env {secret.key}=
              <span className="iris">{secretRef(project, env, secret)}</span> -- npm start
            </span>
            <CopyButton value={command} secret={false} className="small ghost" />
          </div>
        )}

        <ErrorLine error={error} />
        {confirmDelete && (
          <div className="actions" style={{ justifyContent: 'flex-end' }}>
            <span className="secondary" style={{ alignSelf: 'center' }}>
              Move “{secret.name}” to Trash? You can restore it for 30 days.
            </span>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Moving…' : 'Move to Trash'}
            </button>
          </div>
        )}
      </div>
      {share && sharing && (
        <Sheet
          popover
          title={`Share ${secret.name}`}
          subtitle="End-to-end encrypted on this Mac. Zvault never sees the value."
          onClose={() => setShare(null)}
        >
          {readable.length > 1 && (
            <div className="share-envs" role="group" aria-label="Environment to share">
              <span className="row-label">Environment</span>
              {readable.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="chip"
                  aria-pressed={e.id === share.envId}
                  onClick={() => void startShare(e.id)}
                >
                  <EnvDot env={e} />
                  {e.name}
                </button>
              ))}
            </div>
          )}
          {readable.length === 1 && sharedEnv && (
            <span className="row-sub">Shares the {sharedEnv.name} value.</span>
          )}
          <ShareItem key={share.envId} api={sharing} item={share.payload} />
        </Sheet>
      )}
      {historyOpen && (
        <Sheet
          title={`History of ${secret.name}`}
          subtitle={`${project.name} · earlier versions, decrypted on this Mac`}
          icon={
            <span className="tile">
              <Icon name="key" size={16} />
            </span>
          }
          width={620}
          onClose={() => setHistoryOpen(false)}
        >
          <SecretHistory
            key={secret.revision}
            project={project}
            secret={secret}
            canEdit={props.canEdit}
            onRestored={() => setHistoryOpen(false)}
          />
        </Sheet>
      )}
    </>
  );
}

const TYPE_ICON = { group: 'people', agent: 'agent', account: null } as const;

/** Everyone with a grant in the project: their level here and where else they reach. */
function SecretAccessList({
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
      <div className="access-list">
        <div className="access-row">
          <span className="avatar">{email[0]?.toUpperCase()}</span>
          <span className="row-main">
            <span className="row-title">You</span>
            <span className="row-sub">Only you. Share the project with a team to add people.</span>
          </span>
          <span className="level" data-level={env.locked ? 'none' : 'manage'}>
            {env.locked ? 'No access' : project.owner ? 'Owner' : 'Edit'}
          </span>
        </div>
      </div>
    );
  }
  const users = secretAccess(
    buildMatrix({ access: team.access, envs: team.envs, org: team.org, meEmail: email }),
    env.id,
  );
  if (users.length === 0) {
    return <span className="muted">Nobody has access to {project.name} yet.</span>;
  }
  return (
    <div className="access-list">
      {users.map((u) => {
        const icon = TYPE_ICON[u.type];
        return (
          <div key={u.key} className="access-row">
            <span className="avatar" data-type={u.type}>
              {icon ? <Icon name={icon} size={14} /> : u.name[0]?.toUpperCase()}
            </span>
            <span className="row-main">
              <span className="row-title truncate">{u.you ? 'You' : u.name}</span>
              <span className="row-sub truncate">{u.detail}</span>
            </span>
            <span className="env-scope">
              {project.environments
                .filter((e) => u.envIds.includes(e.id))
                .map((e) => (
                  <span key={e.id} className="chip" title={e.name}>
                    <EnvDot env={e} />
                    {e.short}
                  </span>
                ))}
            </span>
            <span className="level" data-level={levelAttr(u.level)}>
              {u.level === 'none' ? `Not in ${env.short}` : LEVEL_LABELS[u.level]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

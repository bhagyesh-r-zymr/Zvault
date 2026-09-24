import { useMemo, useState } from 'react';
import { CopyButton, SecretText } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';
import {
  ACCESS_LABELS,
  accessFor,
  ENV_COLORS,
  secretRef,
  useProjects,
  type Environment,
  type Project,
  type ProjectSecret,
  type SecretKind,
} from './model.js';
import { NewSecretSheet } from './NewSecretSheet.js';
import './projects.css';

export const KIND_ICON: Record<SecretKind, IconName> = {
  database: 'database',
  apiKey: 'key',
  login: 'globe',
  email: 'mail',
  sshKey: 'terminal',
  note: 'note',
};

export function EnvDot({ env }: { env: Environment }) {
  return <span className="dot" style={{ background: ENV_COLORS[env.color] }} />;
}

export function ProjectTile({
  project,
  size = 'small',
}: {
  project: Project;
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
  onOpenAccess: () => void;
}) {
  const { projects, secrets } = useProjects();
  const project = projects.find((p) => p.id === props.projectId) ?? projects[0]!;
  const env = project.environments.find((e) => e.id === props.envId) ?? project.environments[0]!;

  const [selected, setSelected] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const inProject = useMemo(
    () => secrets.filter((s) => s.projectId === project.id),
    [secrets, project.id],
  );
  const allTags = useMemo(() => [...new Set(inProject.flatMap((s) => s.tags))].sort(), [inProject]);
  const visible = inProject
    .filter((s) => s.values[env.id])
    .filter((s) => tags.every((t) => s.tags.includes(t)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const folders = [...new Set(visible.flatMap((s) => (s.folder ? [s.folder] : [])))].sort();
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
        <Icon name={KIND_ICON[s.kind]} size={15} />
      </span>
      <span className="row-main">
        <span className="row-title truncate">{s.name}</span>
        <span className="row-sub mono truncate" style={{ fontSize: 11 }}>
          {s.envVars.join(', ') || s.tags.map((t) => `#${t}`).join(' ')}
        </span>
      </span>
    </button>
  );

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
          {folders.map((folder) => {
            const open = !closed.includes(folder);
            const items = visible.filter((s) => s.folder === folder);
            return (
              <div key={folder} style={{ display: 'contents' }}>
                <button
                  type="button"
                  className="list-folder"
                  aria-expanded={open}
                  onClick={() => setClosed(toggle(closed, folder))}
                >
                  <Icon
                    name={open ? 'chevronDown' : 'chevronRight'}
                    size={11}
                    strokeWidth={3}
                    className="nav-caret"
                  />
                  <Icon name="folder" size={16} className="secondary" />
                  <span className="label">{folder}</span>
                  <span className="n muted">{items.length}</span>
                </button>
                {open && items.map((s) => row(s, true))}
              </div>
            );
          })}
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
          defaultEnv={env.id}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSelected(s.id);
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
  onEnvChange: (envId: string) => void;
  onOpenAccess: () => void;
}) {
  const { project, env, secret } = props;
  const [revealed, setRevealed] = useState<string[]>([]);
  const fields = secret.values[env.id] ?? [];
  const access = accessFor(project.id).filter(
    (a) => a.levels[env.id] && a.levels[env.id] !== 'none',
  );

  return (
    <>
      <div className="detail-bar">
        <span className="truncate">
          {project.name} / {env.name}
          {secret.folder && ` / ${secret.folder}`}
        </span>
      </div>
      <div className="detail-body">
        <PreviewNote>
          Sample data. Projects and environments sync to your team once the server side ships.
        </PreviewNote>
        <div className="item-head">
          <span className="tile large">
            <Icon name={KIND_ICON[secret.kind]} size={24} />
          </span>
          <div>
            <h1>{secret.name}</h1>
            <div className="tags">
              <span className="pill" style={{ height: 22, color: ENV_COLORS[env.color] }}>
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
            {project.environments.map((e) => {
              const set = !!secret.values[e.id];
              return (
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
                  <span>
                    {e.id === env.id
                      ? 'viewing'
                      : !set
                        ? 'not set'
                        : e.restricted
                          ? 'managers only'
                          : 'set'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel rows">
          {fields.map((field) => {
            const shown = !field.secret || revealed.includes(field.label);
            return (
              <div key={field.label} className="row">
                <div className="row-main">
                  <span className="row-label">{field.label}</span>
                  {field.secret ? (
                    <SecretText value={field.value} masked={!shown} />
                  ) : (
                    <span className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                      {field.value}
                    </span>
                  )}
                </div>
                {field.secret && (
                  <button
                    type="button"
                    className="small"
                    onClick={() =>
                      setRevealed(
                        shown
                          ? revealed.filter((l) => l !== field.label)
                          : [...revealed, field.label],
                      )
                    }
                  >
                    {shown ? 'Hide' : 'Reveal'}
                  </button>
                )}
                <CopyButton value={field.value} secret={!!field.secret} />
              </div>
            );
          })}
        </div>

        {secret.envVars.length > 0 && fields[0] && (
          <div>
            <div className="section-label">
              <span>Use it from the terminal</span>
            </div>
            <div className="panel panel-pad mono ref-box">
              zv run --env {secret.envVars[secret.envVars.length - 1]}=
              <span className="iris">
                {secretRef(project, env, secret, fields[fields.length - 1]!.label)}
              </span>{' '}
              -- npm start
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
          <div className="tags">
            {access.map((a) => (
              <span key={a.id} className={a.kind === 'agent' ? 'pill attn' : 'pill'}>
                <span
                  style={{ fontWeight: 600, color: a.kind === 'agent' ? undefined : 'var(--text)' }}
                >
                  {a.name}
                </span>
                {a.note ?? ACCESS_LABELS[a.levels[env.id]!].toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

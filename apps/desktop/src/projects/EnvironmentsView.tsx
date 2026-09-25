import { slugify, type EnvironmentKind } from '@zvault/shared';
import { useId, useState, type FormEvent } from 'react';
import { ErrorLine, Segmented, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { writeError } from './api.js';
import { useProjects, useProjectsSync, useProjectTeam } from './context.js';
import { ENV_COLORS, ENV_KIND_LABELS, type Environment, type Project } from './model.js';
import { EnvDot, ProjectTile } from './ProjectsView.js';
import { isOrgAdmin } from './teamModel.js';

const KINDS: readonly { value: EnvironmentKind; label: string }[] = (
  ['development', 'staging', 'production', 'custom'] as const
).map((value) => ({ value, label: ENV_KIND_LABELS[value] }));

/** A project's environments: add, rename, change the slug or type, and delete. */
export function EnvironmentsView(props: {
  projectId: string;
  onOpenEnvironment: (envId: string) => void;
}) {
  const { projects, secrets } = useProjects();
  const sync = useProjectsSync();
  const team = useProjectTeam(props.projectId);
  const project = projects.find((p) => p.id === props.projectId);
  const [editing, setEditing] = useState<Environment | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) {
    return (
      <div className="empty">
        <Icon name="folder" size={32} />
        <span>This project is no longer available.</span>
      </div>
    );
  }

  // The API lets the owner, and org owners and admins, change structure.
  const canManage = project.owner || isOrgAdmin(team?.org ?? null);
  const inProject = secrets.filter((s) => s.projectId === project.id);

  const remove = async (env: Environment) => {
    setBusy(true);
    setError(null);
    try {
      await sync.deleteEnvironment(project.id, env.id);
      setDeleting(null);
    } catch (e) {
      setError(writeError(e, 'The environment could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  const consequence = (env: Environment) => {
    if (env.locked) return 'Its values go with it.';
    const values = inProject.filter((s) => s.values[env.id]).length;
    const only = sync.secretsOnlyIn(project.id, env.id).length;
    const parts = [
      values === 0
        ? 'It holds no values.'
        : `Its ${values === 1 ? 'value' : `${values} values`} and key go with it.`,
    ];
    if (only > 0) {
      parts.push(
        `${only === 1 ? '1 secret has' : `${only} secrets have`} no value anywhere else and will be deleted.`,
      );
    }
    return parts.join(' ');
  };

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-head">
          <ProjectTile project={project} size="large" />
          <div>
            <h1>{project.name} · Environments</h1>
            <p>
              Each environment has its own key, so access to one never reveals another. Secrets are
              referenced as <span className="mono">zv://{project.slug}/&lt;slug&gt;/…</span>
            </p>
          </div>
          {canManage && project.environments.length > 0 && (
            <button type="button" className="primary" onClick={() => setEditing('new')}>
              <Icon name="plus" size={13} strokeWidth={2.4} />
              New environment
            </button>
          )}
        </div>

        {project.environments.length === 0 ? (
          <div className="panel panel-pad env-empty">
            <Icon name="folder" size={28} />
            <strong>No environments yet</strong>
            <span className="secondary">
              Add one for each place your secrets are used, such as Development or Production.
            </span>
            {canManage ? (
              <button type="button" className="primary" onClick={() => setEditing('new')}>
                <Icon name="plus" size={13} strokeWidth={2.4} />
                Create environment
              </button>
            ) : (
              <span className="hint">Only the project owner or an admin can add environments.</span>
            )}
          </div>
        ) : (
          <div className="panel rows">
            {project.environments.map((env) => {
              const from = project.environments.find((e) => e.id === env.inheritsFrom);
              return (
                <div key={env.id} className="row env-row">
                  <EnvDot env={env} />
                  <div className="row-main">
                    <span className="row-title">
                      {env.name}
                      {env.locked && (
                        <Icon name="lock" size={12} className="muted" aria-label="No access" />
                      )}
                    </span>
                    <span className="row-sub">
                      <span className="mono">{env.slug}</span> · {ENV_KIND_LABELS[env.kind]}
                      {from && ` · falls back to ${from.name}`}
                    </span>
                  </div>
                  {deleting === env.id ? (
                    <>
                      <span className="secondary env-confirm">
                        Delete {env.name}? {consequence(env)}
                      </span>
                      <button type="button" disabled={busy} onClick={() => setDeleting(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => void remove(env)}
                      >
                        {busy ? 'Deleting…' : 'Delete'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="small ghost"
                        onClick={() => props.onOpenEnvironment(env.id)}
                      >
                        Open
                      </button>
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="small"
                            onClick={() => {
                              setError(null);
                              setEditing(env);
                            }}
                          >
                            <Icon name="edit" size={12} /> Edit
                          </button>
                          <button
                            type="button"
                            className="icon ghost"
                            aria-label={`Delete ${env.name}`}
                            title="Delete"
                            onClick={() => {
                              setError(null);
                              setDeleting(env.id);
                            }}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!canManage && project.environments.length > 0 && (
          <span className="hint">
            Only the project owner or an organization admin can change environments.
          </span>
        )}
        <ErrorLine error={error} />
      </div>

      {editing && (
        <EnvironmentSheet
          project={project}
          env={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(envId, created) => {
            setEditing(null);
            if (created && project.environments.length === 0) props.onOpenEnvironment(envId);
          }}
        />
      )}
    </div>
  );
}

/** Creates an environment, or edits one's name, slug, type and fallback. */
export function EnvironmentSheet(props: {
  project: Project;
  /** `null` to create one. */
  env: Environment | null;
  onClose: () => void;
  onSaved: (envId: string, created: boolean) => void;
}) {
  const { project, env } = props;
  const sync = useProjectsSync();
  const [name, setName] = useState(env?.name ?? '');
  const [slug, setSlug] = useState(env?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(env !== null);
  const [kind, setKind] = useState<EnvironmentKind>(env?.kind ?? 'custom');
  const [inheritsFrom, setInheritsFrom] = useState(env?.inheritsFrom ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), slug: useId(), from: useId() };
  const others = project.environments.filter((e) => e.id !== env?.id);
  const shownSlug = slugTouched ? slug : slugify(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the environment a name.');
    if (!shownSlug) return setError('Give it a slug, such as staging.');
    setBusy(true);
    setError(null);
    const draft = { name, slug: shownSlug, kind, inheritsFrom: inheritsFrom || null };
    try {
      if (env) {
        await sync.updateEnvironment(project.id, env.id, draft);
        props.onSaved(env.id, false);
      } else {
        props.onSaved(await sync.createEnvironment(project.id, draft), true);
      }
    } catch (err) {
      setError(writeError(err, 'The environment could not be saved.'));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={env ? `Edit ${env.name}` : 'New environment'}
      subtitle={env ? 'Its key and values stay as they are' : 'It gets its own key on this Mac'}
      onClose={props.onClose}
      width={480}
    >
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.name}>Name</label>
            <input
              id={ids.name}
              value={name}
              autoFocus
              maxLength={64}
              placeholder="Staging"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.slug}>Slug</label>
            <input
              id={ids.slug}
              className="mono"
              value={shownSlug}
              maxLength={64}
              placeholder="staging"
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
              }}
            />
          </div>
        </div>
        <span className="hint" style={{ marginTop: -8 }}>
          Referenced as{' '}
          <span className="mono">
            zv://{project.slug}/{shownSlug || 'slug'}/…
          </span>
          {env && shownSlug !== env.slug && '. Scripts using the old slug will stop finding it.'}
        </span>

        <div className="field">
          <label>Type</label>
          <Segmented
            label="Type"
            options={KINDS.map((k) => ({
              value: k.value,
              label: (
                <>
                  <span className="dot" style={{ background: ENV_COLORS[k.value] }} />
                  {k.label}
                </>
              ),
            }))}
            value={kind}
            onChange={setKind}
          />
        </div>

        {others.length > 0 && (
          <div className="field">
            <label htmlFor={ids.from}>When a secret has no value here</label>
            <select
              id={ids.from}
              value={inheritsFrom}
              onChange={(e) => setInheritsFrom(e.target.value)}
            >
              <option value="">Leave it unset</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  Use the value from {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : env ? 'Save' : 'Create environment'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

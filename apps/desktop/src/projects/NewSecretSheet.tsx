import { useId, useState, type FormEvent } from 'react';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { previewProjects, useProjects, type Project, type ProjectSecret } from './model.js';
import { EnvDot } from './ProjectsView.js';

const TAG_SUGGESTIONS = ['rotate-quarterly', 'third-party', 'database', 'aws', 'payments'];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const envVarOf = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Adds a secret with one value per environment, an optional folder and tags. */
export function NewSecretSheet(props: {
  project: Project;
  defaultEnv: string;
  onClose: () => void;
  onCreated: (secret: ProjectSecret) => void;
}) {
  const { projects, secrets } = useProjects();
  const [projectId, setProjectId] = useState(props.project.id);
  const project = projects.find((p) => p.id === projectId) ?? props.project;
  const [name, setName] = useState('');
  const [envVar, setEnvVar] = useState('');
  const [envVarTouched, setEnvVarTouched] = useState(false);
  const [folder, setFolder] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [newEnv, setNewEnv] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), env: useId(), project: useId(), folder: useId(), tags: useId() };

  const folders = [
    ...new Set(
      secrets.filter((s) => s.projectId === projectId).flatMap((s) => (s.folder ? [s.folder] : [])),
    ),
  ].sort();

  const addTag = (raw: string) => {
    const t = slugify(raw.replace(/^#/, ''));
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const filled = project.environments.filter((env) => values[env.id]?.trim());
    if (!name.trim()) return setError('Give the secret a name.');
    if (filled.length === 0) return setError('Add a value for at least one environment.');
    // An empty environment inherits the one before it, as the placeholder says.
    const byEnv: ProjectSecret['values'] = {};
    let last: string | undefined;
    for (const env of project.environments) {
      const v = values[env.id]?.trim() || (env.restricted ? undefined : last);
      if (v) byEnv[env.id] = [{ label: 'value', value: v, secret: true }];
      if (values[env.id]?.trim()) last = values[env.id]!.trim();
    }
    const created = previewProjects.addSecret({
      projectId,
      name: name.trim(),
      slug: slugify(name) || 'secret',
      envVars: envVar ? [envVar] : [],
      kind: 'apiKey',
      ...(folder.trim() && { folder: slugify(folder) }),
      tags,
      values: byEnv,
    });
    props.onCreated(created);
  };

  return (
    <Sheet
      title="New secret"
      subtitle="Encrypted on this Mac before it is saved"
      onClose={props.onClose}
      width={580}
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.name}>Name</label>
            <input
              id={ids.name}
              value={name}
              autoFocus
              placeholder="Stripe secret key"
              onChange={(e) => {
                setName(e.target.value);
                if (!envVarTouched) setEnvVar(envVarOf(e.target.value));
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.env}>Variable name for zv run</label>
            <input
              id={ids.env}
              className="mono"
              value={envVar}
              placeholder="STRIPE_SECRET_KEY"
              onChange={(e) => {
                setEnvVarTouched(true);
                setEnvVar(envVarOf(e.target.value));
              }}
            />
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.project}>Project</label>
            <select
              id={ids.project}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.folder}>Folder (optional)</label>
            <input
              id={ids.folder}
              list={`${ids.folder}-list`}
              value={folder}
              placeholder="billing"
              onChange={(e) => setFolder(e.target.value)}
            />
            <datalist id={`${ids.folder}-list`}>
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
        </div>

        <div>
          <div className="section-label">
            <span>Value per environment</span>
            {newEnv === null && (
              <button
                type="button"
                className="link"
                style={{ fontSize: 12 }}
                onClick={() => setNewEnv('')}
              >
                + Custom environment
              </button>
            )}
          </div>
          <div className="env-values">
            {project.environments.map((env, i) => (
              <div key={env.id}>
                <span className="env-name">
                  <EnvDot env={env} />
                  {env.name}
                </span>
                <input
                  type="password"
                  aria-label={`${env.name} value`}
                  autoComplete="off"
                  value={values[env.id] ?? ''}
                  placeholder={
                    env.restricted
                      ? 'Not set'
                      : i === 0
                        ? 'Paste the value'
                        : `Same as ${project.environments[i - 1]!.name}`
                  }
                  onChange={(e) => setValues({ ...values, [env.id]: e.target.value })}
                />
                {env.restricted && (
                  <span title="Managers only" className="muted">
                    <Icon name="lock" size={13} />
                  </span>
                )}
              </div>
            ))}
            {newEnv !== null && (
              <div>
                <input
                  aria-label="New environment name"
                  autoFocus
                  value={newEnv}
                  placeholder="e.g. QA sandbox"
                  style={{ fontFamily: 'var(--font)' }}
                  onChange={(e) => setNewEnv(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (newEnv.trim()) previewProjects.addEnvironment(projectId, newEnv.trim());
                      setNewEnv(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="small"
                  disabled={!newEnv.trim()}
                  onClick={() => {
                    previewProjects.addEnvironment(projectId, newEnv.trim());
                    setNewEnv(null);
                  }}
                >
                  Add
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.tags}>Tags</label>
          <div className="tag-input">
            {tags.map((t) => (
              <span key={t} className="chip active">
                #{t}
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id={ids.tags}
              value={tagDraft}
              placeholder={tags.length ? '' : 'Type a tag and press Enter'}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag(tagDraft);
                } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
                  setTags(tags.slice(0, -1));
                }
              }}
            />
          </div>
          <div className="tags" style={{ alignItems: 'center' }}>
            <span className="hint">Suggestions</span>
            {TAG_SUGGESTIONS.filter((t) => !tags.includes(t)).map((t) => (
              <button key={t} type="button" className="chip" onClick={() => addTag(t)}>
                #{t}
              </button>
            ))}
          </div>
        </div>

        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save secret
          </button>
        </div>
      </form>
    </Sheet>
  );
}

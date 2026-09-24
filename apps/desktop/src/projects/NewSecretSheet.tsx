import { SecretKeyName, slugify } from '@zvault/shared';
import { useId, useState, type FormEvent } from 'react';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { writeError } from './api.js';
import { useProjects, useProjectsSync } from './context.js';
import type { Project } from './model.js';
import { EnvDot } from './ProjectsView.js';

const TAG_SUGGESTIONS = ['rotate-quarterly', 'third-party', 'database', 'aws', 'payments'];

const envVarOf = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Adds a secret with one value per environment, an optional folder and tags. */
export function NewSecretSheet(props: {
  project: Project;
  onClose: () => void;
  onCreated: (created: { projectId: string; secretId: string; envIds: string[] }) => void;
}) {
  const { projects } = useProjects();
  const sync = useProjectsSync();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), env: useId(), project: useId(), folder: useId(), tags: useId() };

  const addTag = (raw: string) => {
    const t = slugify(raw.replace(/^#/, '')).slice(0, 48);
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  const addEnvironment = async () => {
    const envName = newEnv?.trim();
    if (!envName) return setNewEnv(null);
    setBusy(true);
    setError(null);
    try {
      await sync.createEnvironment(projectId, envName);
      setNewEnv(null);
    } catch (e) {
      setError(writeError(e, 'The environment could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const filled = project.environments.filter((env) => !env.locked && values[env.id]?.trim());
    if (!name.trim()) return setError('Give the secret a name.');
    if (!SecretKeyName.safeParse(envVar).success) {
      return setError('Give it a variable name, such as STRIPE_SECRET_KEY.');
    }
    if (filled.length === 0) return setError('Add a value for at least one environment.');
    const folderName = folder.trim();
    const existing = project.folders.find(
      (f) => f.name.toLowerCase() === folderName.toLowerCase() || f.slug === slugify(folderName),
    );
    if (folderName && !existing && !project.owner) {
      return setError('Only the project owner can add folders. Pick an existing one.');
    }
    setBusy(true);
    setError(null);
    try {
      const folderId = !folderName
        ? null
        : (existing?.id ?? (await sync.createFolder(projectId, folderName)));
      const secretId = await sync.createSecret(projectId, {
        name,
        key: envVar,
        folderId,
        tags,
        values: Object.fromEntries(filled.map((env) => [env.id, values[env.id]!.trim()])),
      });
      props.onCreated({ projectId, secretId, envIds: filled.map((env) => env.id) });
    } catch (err) {
      setError(writeError(err, 'The secret could not be saved.'));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New secret"
      subtitle="Encrypted on this Mac before it is saved"
      onClose={props.onClose}
      width={580}
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
              onChange={(e) => {
                setProjectId(e.target.value);
                setValues({});
                setNewEnv(null);
              }}
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
              {project.folders.map((f) => (
                <option key={f.id} value={f.name} />
              ))}
            </datalist>
          </div>
        </div>

        <div>
          <div className="section-label">
            <span>Value per environment</span>
            {newEnv === null && project.owner && (
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
            {project.environments.map((env, i) => {
              const parent = project.environments.find((x) => x.id === env.inheritsFrom);
              return (
                <div key={env.id}>
                  <span className="env-name">
                    <EnvDot env={env} />
                    {env.name}
                  </span>
                  <input
                    type="password"
                    aria-label={`${env.name} value`}
                    autoComplete="off"
                    disabled={env.locked}
                    value={values[env.id] ?? ''}
                    placeholder={
                      env.locked
                        ? 'No access'
                        : parent
                          ? `Same as ${parent.name}`
                          : i === 0
                            ? 'Paste the value'
                            : 'Not set'
                    }
                    onChange={(e) => setValues({ ...values, [env.id]: e.target.value })}
                  />
                  {env.locked && (
                    <span title="You don't have access to this environment" className="muted">
                      <Icon name="lock" size={13} />
                    </span>
                  )}
                </div>
              );
            })}
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
                      void addEnvironment();
                    }
                  }}
                />
                <button
                  type="button"
                  className="small"
                  disabled={!newEnv.trim() || busy}
                  onClick={() => void addEnvironment()}
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
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save secret'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

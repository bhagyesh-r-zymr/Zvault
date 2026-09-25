import { slugify } from '@zvault/shared';
import { useId, useState, type FormEvent } from 'react';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { writeError } from './api.js';
import { useProjectsSync } from './context.js';

/** Creates a project with a fresh key. It starts with no environments. */
export function NewProjectSheet(props: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const sync = useProjectsSync();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the project a name.');
    if (!slugify(name)) return setError('Use at least one letter or digit in the name.');
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await sync.createProject(name));
    } catch (err) {
      setError(writeError(err, 'The project could not be created.'));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New project"
      subtitle="Its own keys are created on this Mac"
      onClose={props.onClose}
      width={460}
    >
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="field">
          <label htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            value={name}
            autoFocus
            maxLength={100}
            placeholder="Payments API"
            onChange={(e) => setName(e.target.value)}
          />
          <span className="hint">
            You add its environments next. Referenced as{' '}
            <span className="mono">zv://{slugify(name) || 'project'}/…</span>
          </span>
        </div>
        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

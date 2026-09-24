import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ConflictError, type VaultApi } from './api.js';
import { vaultCore, type ItemFields, type VaultCore } from './core.js';
import { openDefaultVault, VaultSync } from './sync.js';
import './vault.css';

const SYNC_INTERVAL_MS = 30_000;
const CLIPBOARD_CLEAR_MS = 30_000;

const EMPTY: ItemFields = { title: '', username: '', password: '', urls: [], notes: '' };

type Pane = { mode: 'view'; id: string } | { mode: 'edit'; id: string | null } | { mode: 'none' };

/**
 * The main vault screen, shown once the account is unlocked. The login flow
 * mounts it with an API client that carries the session token.
 */
export function VaultScreen({ api, core = vaultCore }: { api: VaultApi; core?: VaultCore }) {
  const [sync, setSync] = useState<VaultSync | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openDefaultVault(api, core)
      .then(async (vault) => {
        const s = new VaultSync(api, core, vault);
        await s.pull();
        if (!cancelled) setSync(s);
      })
      .catch((e: unknown) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [api, core]);

  if (error) return <p role="alert">Could not open your vault: {error}</p>;
  if (!sync) return <p aria-busy="true">Opening your vault…</p>;
  return <VaultView sync={sync} />;
}

function VaultView({ sync }: { sync: VaultSync }) {
  const items = useSyncExternalStore(sync.subscribe, sync.items);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>({ mode: 'none' });
  const [syncError, setSyncError] = useState<string | null>(null);

  const pull = useCallback(() => {
    sync.pull().then(
      () => setSyncError(null),
      (e: unknown) => setSyncError(message(e)),
    );
  }, [sync]);

  useEffect(() => {
    const timer = setInterval(pull, SYNC_INTERVAL_MS);
    window.addEventListener('focus', pull);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', pull);
    };
  }, [pull]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(({ summary: s }) =>
      [s.title, s.username, s.url ?? ''].some((v) => v.toLowerCase().includes(q)),
    );
  }, [items, query]);

  // Leave a pane whose item was deleted on another device.
  const selectedGone =
    pane.mode !== 'none' && pane.id !== null && !items.some((i) => i.id === pane.id);
  useEffect(() => {
    if (selectedGone) setPane({ mode: 'none' });
  }, [selectedGone]);

  return (
    <div className="vault">
      <aside className="vault-list">
        <header>
          <h2>{sync.vault.name}</h2>
          <button type="button" onClick={() => setPane({ mode: 'edit', id: null })}>
            New item
          </button>
        </header>
        <input
          type="search"
          placeholder="Search"
          aria-label="Search items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul>
          {visible.map(({ id, summary }) => (
            <li key={id}>
              <button
                type="button"
                aria-current={pane.mode !== 'none' && pane.id === id}
                onClick={() => setPane({ mode: 'view', id })}
              >
                <strong>{summary.title || 'Untitled'}</strong>
                <span>{summary.username}</span>
              </button>
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="muted">No items yet.</p>}
        <footer>
          <button type="button" onClick={pull}>
            Sync now
          </button>
          {syncError && <span role="alert">Sync failed: {syncError}</span>}
          {sync.unreadable > 0 && (
            <span role="alert">{sync.unreadable} item(s) could not be decrypted.</span>
          )}
        </footer>
      </aside>
      <section className="vault-pane">
        {pane.mode === 'view' && (
          <ItemDetail
            key={`${pane.id}:${items.find((i) => i.id === pane.id)?.revision}`}
            sync={sync}
            id={pane.id}
            onEdit={() => setPane({ mode: 'edit', id: pane.id })}
            onDeleted={() => setPane({ mode: 'none' })}
          />
        )}
        {pane.mode === 'edit' && (
          <ItemEditor
            key={pane.id ?? 'new'}
            sync={sync}
            id={pane.id}
            onDone={(id) => setPane(id ? { mode: 'view', id } : { mode: 'none' })}
          />
        )}
        {pane.mode === 'none' && <p className="muted">Select an item or create a new one.</p>}
      </section>
    </div>
  );
}

function ItemDetail(props: {
  sync: VaultSync;
  id: string;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { sync, id, onEdit, onDeleted } = props;
  const [fields, setFields] = useState<ItemFields | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sync.open(id).then(setFields, (e: unknown) => setError(message(e)));
  }, [sync, id]);

  const remove = () => {
    if (!window.confirm(`Delete “${fields?.title || 'this item'}”?`)) return;
    sync.remove(id).then(onDeleted, (e: unknown) => setError(message(e)));
  };

  if (error) return <p role="alert">{error}</p>;
  if (!fields) return null;
  return (
    <article>
      <h2>{fields.title || 'Untitled'}</h2>
      <dl>
        <dt>Username</dt>
        <dd>
          {fields.username} <CopyButton value={fields.username} />
        </dd>
        <dt>Password</dt>
        <dd>
          <code>{revealed ? fields.password : '••••••••••••'}</code>{' '}
          <button type="button" onClick={() => setRevealed((r) => !r)}>
            {revealed ? 'Hide' : 'Reveal'}
          </button>{' '}
          <CopyButton value={fields.password} />
        </dd>
        {fields.urls.length > 0 && (
          <>
            <dt>Websites</dt>
            {fields.urls.map((url) => (
              <dd key={url}>{url}</dd>
            ))}
          </>
        )}
        {fields.notes && (
          <>
            <dt>Notes</dt>
            <dd className="notes">{fields.notes}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        <button type="button" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="danger" onClick={remove}>
          Delete
        </button>
      </div>
    </article>
  );
}

function ItemEditor(props: {
  sync: VaultSync;
  id: string | null;
  onDone: (id: string | null) => void;
}) {
  const { sync, id, onDone } = props;
  const [fields, setFields] = useState<ItemFields | null>(id === null ? EMPTY : null);
  const [urls, setUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) return;
    sync.open(id).then(
      (f) => {
        setFields(f);
        setUrls(f.urls.join('\n'));
      },
      (e: unknown) => setError(message(e)),
    );
  }, [sync, id]);

  if (!fields) return error ? <p role="alert">{error}</p> : null;

  const set =
    (key: 'title' | 'username' | 'password' | 'notes') => (e: { target: { value: string } }) =>
      setFields({ ...fields, [key]: e.target.value });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    sync
      .save(id, { ...fields, urls: urls.split('\n') })
      .then(onDone, (err: unknown) => {
        setError(
          err instanceof ConflictError
            ? 'This item was changed on another device. The latest version has been loaded; save again to overwrite it with your changes.'
            : message(err),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      <h2>{id === null ? 'New item' : 'Edit item'}</h2>
      <label>
        Title
        <input required value={fields.title} onChange={set('title')} autoFocus />
      </label>
      <label>
        Username
        <input value={fields.username} onChange={set('username')} autoComplete="off" />
      </label>
      <label>
        Password
        <input
          type="password"
          value={fields.password}
          onChange={set('password')}
          autoComplete="new-password"
        />
      </label>
      <label>
        Websites (one per line)
        <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={2} />
      </label>
      <label>
        Notes
        <textarea value={fields.notes} onChange={set('notes')} rows={4} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={() => onDone(id)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    // Best effort: clear the clipboard later if it still holds this value.
    setTimeout(() => {
      navigator.clipboard
        .readText()
        .then((current) => (current === value ? navigator.clipboard.writeText('') : undefined))
        .catch(() => undefined);
    }, CLIPBOARD_CLEAR_MS);
  };
  return (
    <button type="button" onClick={() => void copy()} disabled={!value}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

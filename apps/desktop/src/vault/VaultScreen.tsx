import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SharingApi } from '../sharing/api.js';
import { ShareItem } from '../sharing/ShareItem.js';
import { CopyButton, ErrorLine, LetterTile, SecretText, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { ConflictError, type VaultApi } from './api.js';
import { vaultCore, type ItemFields, type VaultCore } from './core.js';
import { openDefaultVault, VaultSync } from './sync.js';
import './vault.css';

const SYNC_INTERVAL_MS = 30_000;

/** Fired by the app shell on ⌘K so the list's search box takes focus. */
export const FOCUS_SEARCH_EVENT = 'zvault:focus-search';

const EMPTY: ItemFields = { title: '', username: '', password: '', urls: [], notes: '' };

type Pane = { mode: 'view'; id: string } | { mode: 'edit'; id: string | null } | { mode: 'none' };

/**
 * The personal vault, shown once the account is unlocked. The login flow
 * mounts it with an API client that carries the session token.
 */
export function VaultScreen({
  api,
  sharing,
  core = vaultCore,
}: {
  api: VaultApi;
  sharing?: SharingApi;
  core?: VaultCore;
}) {
  const [sync, setSync] = useState<VaultSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
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
  }, [api, core, attempt]);

  if (error) {
    return (
      <div className="empty">
        <Icon name="lock" size={32} />
        <h2 style={{ color: 'var(--text)' }}>Couldn&apos;t open your vault</h2>
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" size={14} /> Try again
        </button>
      </div>
    );
  }
  if (!sync) {
    return (
      <div className="empty" aria-busy="true">
        <span className="spinner" />
        Opening your vault…
      </div>
    );
  }
  return <VaultView sync={sync} {...(sharing && { sharing })} />;
}

function VaultView({ sync, sharing }: { sync: VaultSync; sharing?: SharingApi }) {
  const items = useSyncExternalStore(sync.subscribe, sync.items);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>({ mode: 'none' });
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const pull = useCallback(() => {
    setSyncing(true);
    sync
      .pull()
      .then(
        () => setSyncError(null),
        (e: unknown) => setSyncError(message(e)),
      )
      .finally(() => setSyncing(false));
  }, [sync]);

  useEffect(() => {
    const timer = setInterval(pull, SYNC_INTERVAL_MS);
    const focusSearch = () => search.current?.focus();
    window.addEventListener('focus', pull);
    window.addEventListener(FOCUS_SEARCH_EVENT, focusSearch);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', pull);
      window.removeEventListener(FOCUS_SEARCH_EVENT, focusSearch);
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
    <div className="split">
      <section className="list-pane" aria-label="Items">
        <div className="list-head">
          <div className="title-row">
            <span className="crumb">
              <strong>{sync.vault.name}</strong>
            </span>
            <button
              type="button"
              className="primary"
              onClick={() => setPane({ mode: 'edit', id: null })}
            >
              <Icon name="plus" size={13} strokeWidth={2.4} />
              New
            </button>
          </div>
          <input
            ref={search}
            type="search"
            placeholder="Search this vault"
            aria-label="Search items"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="list-body">
          {visible.map(({ id, summary }) => (
            <button
              key={id}
              type="button"
              className="list-item"
              aria-current={pane.mode !== 'none' && pane.id === id}
              onClick={() => setPane({ mode: 'view', id })}
            >
              <LetterTile name={summary.title || '?'} />
              <span className="row-main">
                <span className="row-title truncate">{summary.title || 'Untitled'}</span>
                <span className="row-sub truncate">{summary.username || summary.url || ' '}</span>
              </span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="empty">
              <Icon name="key" size={28} />
              <span>No items yet. Add your first login with New.</span>
            </div>
          )}
          {items.length > 0 && visible.length === 0 && (
            <div className="empty">Nothing matches “{query}”.</div>
          )}
        </div>
        <div className="list-foot">
          <span style={{ flexGrow: 1 }}>
            {items.length} item{items.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="small ghost" onClick={pull} disabled={syncing}>
            <Icon name="refresh" size={12} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {(syncError || sync.unreadable > 0) && (
          <div style={{ padding: '0 12px 12px' }}>
            {syncError && <ErrorLine error={`Sync failed: ${syncError}`} />}
            {sync.unreadable > 0 && (
              <ErrorLine error={`${sync.unreadable} item(s) could not be decrypted.`} />
            )}
          </div>
        )}
      </section>
      <section className="detail-pane" aria-label="Item details">
        {pane.mode === 'view' && (
          <ItemDetail
            key={`${pane.id}:${items.find((i) => i.id === pane.id)?.revision}`}
            sync={sync}
            id={pane.id}
            {...(sharing && { sharing })}
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
        {pane.mode === 'none' && (
          <div className="empty">
            <Icon name="items" size={32} />
            <span>Select an item, or press New to add one.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function ItemDetail(props: {
  sync: VaultSync;
  id: string;
  sharing?: SharingApi;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { sync, id, sharing, onEdit, onDeleted } = props;
  const [fields, setFields] = useState<ItemFields | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sync.open(id).then(setFields, (e: unknown) => setError(message(e)));
  }, [sync, id]);

  // Inline confirmation: WKWebView does not reliably show window.confirm.
  const remove = () => {
    sync.remove(id).then(onDeleted, (e: unknown) => setError(message(e)));
  };

  if (error && !fields)
    return (
      <div className="detail-body">
        <ErrorLine error={error} />
      </div>
    );
  if (!fields) return null;
  const title = fields.title || 'Untitled';
  return (
    <>
      <div className="detail-bar">
        <span>Personal</span>
        {sharing && (
          <button type="button" onClick={() => setSharingOpen(true)}>
            <Icon name="share" size={13} /> Share
          </button>
        )}
        <button type="button" onClick={onEdit}>
          <Icon name="edit" size={13} /> Edit
        </button>
      </div>
      <article className="detail-body">
        <div className="item-head">
          <LetterTile name={title} size="large" />
          <div>
            <h1>{title}</h1>
            {fields.urls[0] && <span className="row-sub">{fields.urls[0]}</span>}
          </div>
        </div>
        <div className="panel rows">
          <div className="row">
            <div className="row-main">
              <span className="row-label">username</span>
              <span style={{ fontSize: 15 }}>{fields.username || '—'}</span>
            </div>
            <CopyButton value={fields.username} secret={false} />
          </div>
          <div className="row">
            <div className="row-main">
              <span className="row-label">password</span>
              {fields.password ? (
                <SecretText value={fields.password} masked={!revealed} />
              ) : (
                <span className="muted">—</span>
              )}
            </div>
            <button
              type="button"
              className="small"
              onClick={() => setRevealed((r) => !r)}
              disabled={!fields.password}
            >
              <Icon name={revealed ? 'eyeOff' : 'eye'} size={13} />
              {revealed ? 'Hide' : 'Reveal'}
            </button>
            <CopyButton value={fields.password} />
          </div>
          {fields.urls.map((url) => (
            <div key={url} className="row">
              <div className="row-main">
                <span className="row-label">website</span>
                <span className="truncate" style={{ color: 'var(--iris-text)' }}>
                  {url}
                </span>
              </div>
              <CopyButton value={url} secret={false} />
            </div>
          ))}
        </div>
        {fields.notes && (
          <div className="panel panel-pad">
            <div className="row-label" style={{ marginBottom: 6 }}>
              notes
            </div>
            <p className="notes">{fields.notes}</p>
          </div>
        )}
        <ErrorLine error={error} />
        <div className="actions" style={{ marginTop: 'auto', justifyContent: 'flex-end' }}>
          {confirmDelete ? (
            <>
              <span className="secondary" style={{ alignSelf: 'center' }}>
                Delete “{title}” on all your devices?
              </span>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={remove}>
                Delete
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={13} /> Delete
            </button>
          )}
        </div>
      </article>
      {sharingOpen && sharing && (
        <Sheet
          title={`Share ${title}`}
          subtitle="Encrypted on this Mac before it leaves"
          icon={<LetterTile name={title} />}
          onClose={() => setSharingOpen(false)}
        >
          <ShareItem
            api={sharing}
            item={{
              v: 1,
              title,
              ...(fields.username && { username: fields.username }),
              ...(fields.password && { password: fields.password }),
              ...(fields.urls[0] && { url: fields.urls[0] }),
              ...(fields.notes && { notes: fields.notes }),
            }}
          />
        </Sheet>
      )}
    </>
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

  if (!fields)
    return error ? (
      <div className="detail-body">
        <ErrorLine error={error} />
      </div>
    ) : null;

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
    <>
      <div className="detail-bar">
        <span>{id === null ? 'New item' : 'Editing'}</span>
      </div>
      <form className="detail-body item-form" onSubmit={submit}>
        <h1>{id === null ? 'New login' : 'Edit item'}</h1>
        <label className="field">
          <span>Title</span>
          <input
            required
            value={fields.title}
            onChange={set('title')}
            autoFocus
            placeholder="GitHub"
          />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Username</span>
            <input value={fields.username} onChange={set('username')} autoComplete="off" />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={fields.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
          </label>
        </div>
        <label className="field">
          <span>Websites (one per line)</span>
          <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={2} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={fields.notes} onChange={set('notes')} rows={4} />
        </label>
        <ErrorLine error={error} />
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => onDone(id)} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

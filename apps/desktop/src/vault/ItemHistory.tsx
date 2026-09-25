import { useEffect, useState } from 'react';
import { stamp } from '../trash/when.js';
import { ErrorLine, SecretText } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { ItemFields } from './core.js';
import type { ItemVersionView, VaultSync } from './sync.js';
import '../trash/history.css';

const FIELD_NAMES: [keyof ItemFields, string][] = [
  ['title', 'title'],
  ['username', 'username'],
  ['password', 'password'],
  ['totp', 'one-time password'],
  ['urls', 'website'],
  ['notes', 'notes'],
];

/** Fields in which `a` and `b` differ, named for people. */
export function changedFields(a: ItemFields, b: ItemFields): string[] {
  return FIELD_NAMES.filter(([k]) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(
    ([, name]) => name,
  );
}

/**
 * Earlier versions of one item, newest first, each decrypted on this Mac.
 * Restoring one makes it the current version; the version it replaces joins
 * the history, so a restore can itself be undone.
 */
export function ItemHistory(props: {
  sync: VaultSync;
  id: string;
  current: ItemFields;
  onRestored: () => void;
}) {
  const { sync, id, current, onRestored } = props;
  const [versions, setVersions] = useState<ItemVersionView[] | null>(null);
  const [revealed, setRevealed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sync.history(id).then(setVersions, (e: unknown) => setError(message(e)));
  }, [sync, id]);

  const restore = (v: ItemVersionView) => {
    setBusy(v.revision);
    setError(null);
    sync.restoreVersion(id, v.cipher).then(onRestored, (e: unknown) => {
      setError(message(e));
      setBusy(null);
    });
  };

  if (!versions) {
    return error ? (
      <ErrorLine error={error} />
    ) : (
      <div className="empty" aria-busy="true">
        <span className="spinner" />
        Decrypting earlier versions…
      </div>
    );
  }

  return (
    <div className="history">
      <p className="history-note">
        <Icon name="shield" size={13} />
        Earlier versions are stored encrypted, like the item. Zvault keeps the last 20.
      </p>
      <ErrorLine error={error} />
      {versions.length === 0 && (
        <div className="empty">
          <Icon name="history" size={26} />
          <span>No earlier versions yet. Each time you save, the previous one is kept here.</span>
        </div>
      )}
      <ol className="history-list">
        {versions.map((v) => {
          const changed = changedFields(v.fields, current);
          return (
            <li key={v.revision} className="history-card">
              <div className="history-head">
                <div className="row-main">
                  <span className="row-title">{stamp(v.savedAt)}</span>
                  <span className="row-sub">
                    {changed.length === 0
                      ? 'Same as the current version'
                      : `Differs in ${changed.join(', ')}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="small"
                  disabled={busy !== null || changed.length === 0}
                  onClick={() => restore(v)}
                >
                  <Icon name="restore" size={13} />
                  {busy === v.revision ? 'Restoring…' : 'Restore'}
                </button>
              </div>
              <dl className="history-fields">
                <dt>title</dt>
                <dd className={changed.includes('title') ? 'changed' : undefined}>
                  {v.fields.title || 'Untitled'}
                </dd>
                <dt>username</dt>
                <dd className={changed.includes('username') ? 'changed' : undefined}>
                  {v.fields.username || '—'}
                </dd>
                <dt>password</dt>
                <dd className={changed.includes('password') ? 'changed' : undefined}>
                  {v.fields.password ? (
                    <>
                      <SecretText value={v.fields.password} masked={revealed !== v.revision} />
                      <button
                        type="button"
                        className="link"
                        onClick={() => setRevealed(revealed === v.revision ? null : v.revision)}
                      >
                        {revealed === v.revision ? 'Hide' : 'Reveal'}
                      </button>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
                {v.fields.urls[0] && (
                  <>
                    <dt>website</dt>
                    <dd className={changed.includes('website') ? 'changed' : undefined}>
                      {v.fields.urls[0]}
                    </dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

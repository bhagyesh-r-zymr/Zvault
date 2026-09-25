import { useEffect, useState } from 'react';
import { stamp } from '../trash/when.js';
import { ErrorLine, SecretText } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { Project, ProjectSecret } from './model.js';
import type { SecretVersionView } from './sync.js';
import { useProjectsSync } from './context.js';
import '../trash/history.css';

/**
 * Earlier versions of one project secret, newest first. Names are decrypted
 * up front; each old value is only decrypted when someone reveals it, and
 * only for environments this account holds a key for.
 */
export function SecretHistory(props: {
  project: Project;
  secret: ProjectSecret;
  canEdit: boolean;
  onRestored: () => void;
}) {
  const { project, secret, canEdit, onRestored } = props;
  const sync = useProjectsSync();
  const [versions, setVersions] = useState<SecretVersionView[] | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sync
      .secretHistory(project.id, secret.id)
      .then(setVersions, (e: unknown) => setError(message(e)));
  }, [sync, project.id, secret.id]);

  const reveal = async (v: SecretVersionView, envId: string) => {
    const key = `${v.revision}:${envId}`;
    if (key in revealed) {
      const rest = { ...revealed };
      delete rest[key];
      return setRevealed(rest);
    }
    try {
      const value = await sync.openHistoricValue(project.id, secret.id, v.version, envId);
      setRevealed({ ...revealed, [key]: value });
    } catch (e) {
      setError(message(e));
    }
  };

  const restore = (v: SecretVersionView) => {
    setBusy(v.revision);
    setError(null);
    sync.restoreSecretVersion(project.id, secret.id, v.version).then(onRestored, (e: unknown) => {
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

  const readable = project.environments.filter((e) => !e.locked);
  return (
    <div className="history">
      <p className="history-note">
        <Icon name="shield" size={13} />
        Old values stay sealed with each environment&apos;s key. Rotating a key clears them.
      </p>
      <ErrorLine error={error} />
      {versions.length === 0 && (
        <div className="empty">
          <Icon name="history" size={26} />
          <span>No earlier versions yet. Each change keeps the previous one here.</span>
        </div>
      )}
      <ol className="history-list">
        {versions.map((v) => {
          const renamed = v.meta.name !== secret.name || v.meta.key !== secret.key;
          return (
            <li key={v.revision} className="history-card">
              <div className="history-head">
                <div className="row-main">
                  <span className="row-title">{stamp(v.savedAt)}</span>
                  <span className="row-sub mono">{v.meta.key}</span>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className="small"
                    disabled={busy !== null}
                    onClick={() => restore(v)}
                  >
                    <Icon name="restore" size={13} />
                    {busy === v.revision ? 'Restoring…' : 'Restore'}
                  </button>
                )}
              </div>
              <dl className="history-fields">
                <dt>name</dt>
                <dd className={renamed ? 'changed' : undefined}>{v.meta.name}</dd>
                {readable.map((env) => {
                  const old = v.version.values.find((x) => x.environmentId === env.id);
                  const now = secret.values[env.id];
                  const changed = (old?.encryptedValue.ct ?? null) !== (now?.ct ?? null);
                  const shown = revealed[`${v.revision}:${env.id}`];
                  return (
                    <div key={env.id} style={{ display: 'contents' }}>
                      <dt>
                        <span className="dot" style={{ background: env.color, marginRight: 6 }} />
                        {env.name}
                      </dt>
                      <dd className={changed ? 'changed' : undefined}>
                        {old ? (
                          <>
                            <SecretText value={shown ?? ''} masked={shown === undefined} />
                            <button
                              type="button"
                              className="link"
                              onClick={() => void reveal(v, env.id)}
                            >
                              {shown === undefined ? 'Reveal' : 'Hide'}
                            </button>
                          </>
                        ) : (
                          <span className="muted">not set</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
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

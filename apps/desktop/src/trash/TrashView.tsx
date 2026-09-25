import { useCallback, useEffect, useState } from 'react';
import { TRASH_RETENTION_DAYS } from '@zvault/shared';
import { useProjects, useProjectsSync } from '../projects/context.js';
import { ProjectTile } from '../projects/ProjectsView.js';
import type { TrashedSecretView } from '../projects/sync.js';
import { ErrorLine, LetterTile } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { VaultApi } from '../vault/api.js';
import { vaultCore, type VaultCore } from '../vault/core.js';
import { openDefaultVault, VaultSync, type TrashedItemView } from '../vault/sync.js';
import { daysLeft, trashLine } from './when.js';
import './history.css';

interface Loaded {
  vault: VaultSync;
  items: TrashedItemView[];
  secrets: TrashedSecretView[];
}

/**
 * Deleted items and project secrets from the last 30 days. Everything shown
 * is decrypted on this Mac from the ciphertext the server kept; restoring
 * uploads that same ciphertext again.
 */
export function TrashView({ api, core = vaultCore }: { api: VaultApi; core?: VaultCore }) {
  const projectsSync = useProjectsSync();
  const { projects } = useProjects();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const vault = new VaultSync(api, core, await openDefaultVault(api, core));
      const [items, secrets] = await Promise.all([vault.trash(), projectsSync.trash()]);
      setLoaded({ vault, items, secrets });
    } catch (e) {
      setError(message(e));
    }
  }, [api, core, projectsSync]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    fn()
      .then(load, (e: unknown) => setError(message(e)))
      .finally(() => {
        setBusy(null);
        setConfirm(null);
      });
  };

  const emptyAll = () =>
    act('empty', async () => {
      await loaded!.vault.purge(null);
      for (const id of new Set(loaded!.secrets.map((s) => s.projectId))) {
        await projectsSync.purge(id, null);
      }
    });

  const total = (loaded?.items.length ?? 0) + (loaded?.secrets.length ?? 0);
  const byProject = projects
    .map((p) => ({
      project: p,
      secrets: loaded?.secrets.filter((s) => s.projectId === p.id) ?? [],
    }))
    .filter((g) => g.secrets.length > 0);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Trash</h1>
            <p>
              Deleted items and secrets stay here for {TRASH_RETENTION_DAYS} days, then they are
              gone for good.
            </p>
          </div>
          {confirm === 'empty' ? (
            <>
              <button type="button" disabled={busy !== null} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="danger" disabled={busy !== null} onClick={emptyAll}>
                {busy === 'empty' ? 'Emptying…' : `Delete ${total} forever`}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={total === 0 || busy !== null}
              onClick={() => setConfirm('empty')}
            >
              <Icon name="trash" size={13} /> Empty trash
            </button>
          )}
        </div>

        <div className="trash-banner">
          <Icon name="shield" size={16} />
          <span>
            The trash is end-to-end encrypted like the rest of your vault. Restoring puts an item
            back exactly as it was when you deleted it.
          </span>
        </div>
        <ErrorLine error={error} />

        {!loaded && !error && (
          <div className="empty" aria-busy="true">
            <span className="spinner" />
            Opening the trash…
          </div>
        )}

        {loaded && total === 0 && (
          <div className="empty">
            <Icon name="trash" size={30} />
            <span>The trash is empty.</span>
          </div>
        )}

        {loaded && loaded.items.length > 0 && (
          <section>
            <div className="section-label">
              <span>{loaded.vault.vault.name}</span>
            </div>
            <ul className="panel rows">
              {loaded.items.map((t) => (
                <TrashRow
                  key={t.id}
                  tile={<LetterTile name={t.summary.title || '?'} />}
                  title={t.summary.title || 'Untitled'}
                  sub={t.summary.username || t.summary.url || 'Login'}
                  deletedAt={t.deletedAt}
                  purgeAt={t.purgeAt}
                  busy={busy}
                  id={t.id}
                  confirming={confirm === t.id}
                  onConfirm={setConfirm}
                  onRestore={() => act(t.id, () => loaded.vault.restoreFromTrash(t.trashed))}
                  onPurge={() => act(t.id, () => loaded.vault.purge(t.id))}
                />
              ))}
            </ul>
          </section>
        )}

        {byProject.map(({ project, secrets }) => (
          <section key={project.id}>
            <div className="section-label">
              <span>{project.name}</span>
            </div>
            <ul className="panel rows">
              {secrets.map((s) => (
                <TrashRow
                  key={s.id}
                  tile={<ProjectTile project={project} />}
                  title={s.meta.name}
                  sub={s.meta.key}
                  mono
                  deletedAt={s.deletedAt}
                  purgeAt={s.purgeAt}
                  busy={busy}
                  id={s.id}
                  confirming={confirm === s.id}
                  onConfirm={setConfirm}
                  onRestore={() =>
                    act(s.id, () => projectsSync.restoreFromTrash(s.projectId, s.trashed))
                  }
                  onPurge={() => act(s.id, () => projectsSync.purge(s.projectId, s.id))}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function TrashRow(props: {
  id: string;
  tile: React.ReactNode;
  title: string;
  sub: string;
  mono?: boolean;
  deletedAt: string;
  purgeAt: string;
  busy: string | null;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const { id, busy, confirming } = props;
  const soon = daysLeft(props.purgeAt) <= 3;
  return (
    <li className="row trash-row">
      {props.tile}
      <div className="row-main">
        <span className="row-title truncate">
          {props.title}
          <span className={props.mono ? 'mono muted' : 'muted'} style={{ fontWeight: 400 }}>
            {'  '}
            {props.sub}
          </span>
        </span>
        <span className={soon ? 'row-sub soon' : 'row-sub'}>
          {trashLine(props.deletedAt, props.purgeAt)}
        </span>
      </div>
      {confirming ? (
        <>
          <button type="button" className="small" onClick={() => props.onConfirm(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="small danger"
            disabled={busy !== null}
            onClick={props.onPurge}
          >
            {busy === id ? 'Deleting…' : 'Delete forever'}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="small ghost"
            disabled={busy !== null}
            onClick={() => props.onConfirm(id)}
          >
            Delete forever
          </button>
          <button
            type="button"
            className="small primary"
            disabled={busy !== null}
            onClick={props.onRestore}
          >
            <Icon name="restore" size={13} />
            {busy === id ? 'Restoring…' : 'Restore'}
          </button>
        </>
      )}
    </li>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

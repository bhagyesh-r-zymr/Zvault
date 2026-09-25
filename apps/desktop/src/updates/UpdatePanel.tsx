import { ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { progressText, updateStore, useUpdates } from './store.js';

/** Settings row: this version, and checking for and installing updates. */
export function UpdatePanel() {
  const u = useUpdates();
  const next = u.check?.available ?? null;

  let status: string;
  if (u.installing) status = progressText(u.progress);
  else if (u.checking) status = 'Checking for updates…';
  else if (!u.check) status = 'Zvault checks for updates when it starts.';
  else if (!u.check.enabled) status = 'This build does not update itself.';
  else if (next) status = `Zvault ${next.version} is available. Installing restarts Zvault.`;
  else status = 'Zvault is up to date.';

  return (
    <>
      <div className="panel rows">
        <div className="row">
          <Icon name={next ? 'download' : 'refresh'} size={18} className="secondary" />
          <div className="row-main">
            <span className="row-title">Zvault {u.check?.currentVersion ?? ''}</span>
            <span className="row-sub">{status}</span>
          </div>
          {next ? (
            <button
              type="button"
              className="primary"
              disabled={u.installing}
              onClick={() => void updateStore.install()}
            >
              Install and restart
            </button>
          ) : (
            <button
              type="button"
              disabled={u.checking || u.installing || u.check?.enabled === false}
              onClick={() => void updateStore.checkNow()}
            >
              Check for updates
            </button>
          )}
        </div>
      </div>
      <ErrorLine error={u.error} />
    </>
  );
}

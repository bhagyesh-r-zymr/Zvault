import { useEffect } from 'react';
import { Icon } from '../ui/Icon.js';
import { progressText, updateStore, useUpdates } from './store.js';

/**
 * Checks for a new Zvault once at launch and, when there is one, offers to
 * install it. Nothing installs until the person says so.
 */
export function UpdateBanner() {
  const u = useUpdates();

  useEffect(() => {
    void updateStore.checkNow();
  }, []);

  const next = u.check?.available;
  if (!next || u.dismissed === next.version) return null;

  return (
    <div className="update-banner" role="status">
      <Icon name="download" size={16} />
      <span>
        {u.installing ? (
          progressText(u.progress)
        ) : (
          <>Zvault {next.version} is available. Installing restarts Zvault, which locks it.</>
        )}
      </span>
      {!u.installing && (
        <>
          <button type="button" className="link" onClick={() => updateStore.dismiss()}>
            Later
          </button>
          <button type="button" className="primary" onClick={() => void updateStore.install()}>
            Install and restart
          </button>
        </>
      )}
    </div>
  );
}

import { useEffect } from 'react';
import { Icon } from '../ui/Icon.js';
import { progressText, updateStore, useUpdates } from './store.js';

/** How stale the last check may get before coming back to Zvault checks again. */
const RECHECK_MS = 30 * 60 * 1000;

/**
 * Checks for a new Zvault at launch, and again when the person comes back to
 * a Zvault left open, and when there is one, offers to install it. Nothing
 * installs until the person says so.
 */
export function UpdateBanner() {
  const u = useUpdates();

  useEffect(() => {
    let last = Date.now();
    void updateStore.checkNow();
    const recheck = () => {
      if (Date.now() - last < RECHECK_MS) return;
      last = Date.now();
      void updateStore.checkNow();
    };
    window.addEventListener('focus', recheck);
    const timer = window.setInterval(recheck, RECHECK_MS);
    return () => {
      window.removeEventListener('focus', recheck);
      window.clearInterval(timer);
    };
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

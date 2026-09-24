import { useState } from 'react';
import { LOCK_REASON_TEXT, lock, type LockReason, type LockStatus } from './lock.js';

interface Props {
  status: LockStatus;
  reason: LockReason | null;
  onUnlocked: () => void;
}

export function LockScreen({ status, reason, onUnlocked }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    action().then(onUnlocked, (e: unknown) => {
      setError(String(e));
      setBusy(false);
    });
  };

  return (
    <section aria-labelledby="lock-title" className="lock">
      <h2 id="lock-title">Zvault is locked</h2>
      {reason && <p>{LOCK_REASON_TEXT[reason]}</p>}
      {status.touchId.enrolled && (
        <button type="button" disabled={busy} onClick={() => run(lock.unlockWithTouchId)}>
          Unlock with Touch ID
        </button>
      )}
      <p className="muted">Master password unlock arrives with sign-in.</p>
      {import.meta.env.DEV && (
        <button type="button" disabled={busy} onClick={() => run(lock.devUnlock)}>
          Dev unlock (throwaway key)
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

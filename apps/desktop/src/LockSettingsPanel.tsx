import { useState } from 'react';
import { LOCK_LIMITS, lock, type LockSettings, type LockStatus } from './lock.js';

interface Props {
  status: LockStatus;
  onChanged: () => void;
}

export function LockSettingsPanel({ status, onChanged }: Props) {
  const [draft, setDraft] = useState<LockSettings>(status.settings);
  const [error, setError] = useState<string | null>(null);

  const save = (next: LockSettings) => {
    setDraft(next);
    setError(null);
    lock.setSettings(next).then(onChanged, (e: unknown) => setError(String(e)));
  };

  const toggleTouchId = () => {
    setError(null);
    const action = status.touchId.enrolled ? lock.disableTouchId : lock.enableTouchId;
    action().then(onChanged, (e: unknown) => setError(String(e)));
  };

  return (
    <fieldset>
      <legend>Security</legend>
      <label>
        Lock after{' '}
        <input
          type="number"
          min={LOCK_LIMITS.idleTimeoutMins.min}
          max={LOCK_LIMITS.idleTimeoutMins.max}
          value={draft.idleTimeoutMins}
          onChange={(e) => save({ ...draft, idleTimeoutMins: e.target.valueAsNumber })}
        />{' '}
        minutes of inactivity
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.lockOnSleep}
          onChange={(e) => save({ ...draft, lockOnSleep: e.target.checked })}
        />{' '}
        Lock when the Mac sleeps
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.lockOnScreenLock}
          onChange={(e) => save({ ...draft, lockOnScreenLock: e.target.checked })}
        />{' '}
        Lock when the screen locks
      </label>
      <label>
        Clear copied passwords after{' '}
        <input
          type="number"
          min={LOCK_LIMITS.clipboardClearSecs.min}
          max={LOCK_LIMITS.clipboardClearSecs.max}
          value={draft.clipboardClearSecs}
          onChange={(e) => save({ ...draft, clipboardClearSecs: e.target.valueAsNumber })}
        />{' '}
        seconds
      </label>
      {status.touchId.available ? (
        <label>
          <input type="checkbox" checked={status.touchId.enrolled} onChange={toggleTouchId} />{' '}
          Unlock with Touch ID (master password needed every 14 days)
        </label>
      ) : (
        <p className="muted">Touch ID is not available on this device.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

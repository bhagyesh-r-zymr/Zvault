import { useState } from 'react';
import { LOCK_REASON_TEXT, lock, type LockReason, type LockStatus } from './lock.js';
import { AuthLayout } from './screens/Form.js';
import { ErrorLine } from './ui/controls.js';
import { BrandMark, Icon } from './ui/Icon.js';

interface Props {
  email: string;
  status: LockStatus;
  reason: LockReason | null;
  onUnlocked: () => void;
  /** Signs out so the user can sign in again with their master password. */
  onUsePassword: () => void;
}

export function LockScreen({ email, status, reason, onUnlocked, onUsePassword }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = () => {
    setBusy(true);
    setError(null);
    lock.unlockWithTouchId().then(onUnlocked, (e: unknown) => {
      setError(String(e));
      setBusy(false);
    });
  };

  return (
    <AuthLayout>
      <div className="auth-top">
        <BrandMark size={68} />
        <h1 id="lock-title">Zvault is locked</h1>
        <span className="account-chip">
          <span className="avatar">{email[0]?.toUpperCase()}</span>
          {email}
        </span>
        {reason && <p>{LOCK_REASON_TEXT[reason]}</p>}
      </div>
      <div className="auth-form" aria-labelledby="lock-title">
        {status.touchId.enrolled && (
          <>
            <button type="button" className="primary large block" disabled={busy} onClick={unlock}>
              <Icon name="fingerprint" size={20} strokeWidth={1.8} />
              {busy ? 'Waiting for Touch ID…' : 'Unlock with Touch ID'}
            </button>
            <div className="divider-or">or</div>
          </>
        )}
        <button
          type="button"
          className={status.touchId.enrolled ? 'large block' : 'primary large block'}
          disabled={busy}
          onClick={onUsePassword}
        >
          Use master password
        </button>
        <ErrorLine error={error} />
      </div>
    </AuthLayout>
  );
}

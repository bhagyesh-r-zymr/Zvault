import { useState, type FormEvent } from 'react';
import { errorMessage } from './auth.js';
import { LOCK_REASON_TEXT, lock, type LockReason, type LockStatus } from './lock.js';
import { AuthLayout, Field } from './screens/Form.js';
import { ErrorLine } from './ui/controls.js';
import { BrandMark, Icon } from './ui/Icon.js';

interface Props {
  email: string;
  status: LockStatus;
  reason: LockReason | null;
  onUnlocked: () => void;
  /** Signs out, for someone who wants to sign in again from scratch. */
  onSignOut: () => void;
}

export function LockScreen({ email, status, reason, onUnlocked, onSignOut }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'touchId' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (kind: 'password' | 'touchId', unlock: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    unlock().then(onUnlocked, (e: unknown) => {
      setError(errorMessage(e));
      setBusy(null);
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('password', () => lock.unlockWithPassword(password));
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
      <form className="auth-form" aria-labelledby="lock-title" onSubmit={submit}>
        {status.touchId.enrolled && (
          <>
            <button
              type="button"
              className="primary large block"
              disabled={busy !== null}
              onClick={() => run('touchId', lock.unlockWithTouchId)}
            >
              <Icon name="fingerprint" size={20} strokeWidth={1.8} />
              {busy === 'touchId' ? 'Waiting for Touch ID…' : 'Unlock with Touch ID'}
            </button>
            <div className="divider-or">or</div>
          </>
        )}
        <fieldset disabled={busy !== null}>
          <Field
            label="Master password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            autoFocus={!status.touchId.enrolled}
          />
        </fieldset>
        <ErrorLine error={error} />
        <button
          type="submit"
          className={status.touchId.enrolled ? 'large block' : 'primary large block'}
          disabled={busy !== null}
        >
          {busy === 'password' && <span className="spinner" aria-hidden="true" />}
          {busy === 'password' ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      <div className="auth-foot">
        <button type="button" className="link" disabled={busy !== null} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </AuthLayout>
  );
}

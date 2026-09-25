import type { AccountRecoveryStatus } from '@zvault/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import {
  changeMasterPassword,
  errorMessage,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  setUpRecovery,
  type Session,
} from '../auth.js';
import { core } from '../core.js';
import { Field } from '../screens/Form.js';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { RecoveryCodeCard } from './RecoveryCodeCard.js';
import './account.css';

type Open = 'password' | 'recovery' | null;

/** Settings > Security: change the master password, and the recovery code. */
export function AccountSecurity({ session }: { session: Session }) {
  const [recovery, setRecovery] = useState<AccountRecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [changed, setChanged] = useState(false);

  const refresh = useCallback(() => {
    api.recoveryStatus(session.token).then(setRecovery, (e: unknown) => setError(errorMessage(e)));
  }, [session.token]);
  useEffect(refresh, [refresh]);

  return (
    <section aria-labelledby="account-security-title" className="account-security">
      <h2 id="account-security-title">Master password and recovery</h2>
      <ErrorLine error={error} />
      <div className="panel rows">
        <div className="row">
          <span className="tile">
            <Icon name="key" size={18} />
          </span>
          <div className="row-main">
            <span className="row-title">Master password</span>
            <span className="row-sub">
              {changed
                ? 'Changed. Your other devices were signed out; sign in there with the new one.'
                : 'Unlocks everything. Changing it keeps your Secret Key and your items.'}
            </span>
          </div>
          <button type="button" onClick={() => setOpen('password')}>
            Change
          </button>
        </div>
        <div className="row">
          <span className={recovery?.enabled ? 'tile tfa-on' : 'tile'}>
            <Icon name={recovery?.enabled ? 'shieldCheck' : 'shield'} size={18} />
          </span>
          <div className="row-main">
            <span className="row-title">
              {recovery === null
                ? 'Recovery code'
                : recovery.enabled
                  ? 'Recovery code is set up'
                  : 'No recovery code yet'}
            </span>
            <span className={recovery && !recovery.enabled ? 'row-sub warning' : 'row-sub'}>
              {recovery?.enabled
                ? `Gets you back in if you forget your master password or lose your Secret Key.${
                    recovery.updatedAt
                      ? ` Made ${new Date(recovery.updatedAt).toLocaleDateString()}.`
                      : ''
                  }`
                : 'Without one, a forgotten master password means your data is gone for good.'}
            </span>
          </div>
          <button
            type="button"
            className={recovery && !recovery.enabled ? 'primary' : undefined}
            disabled={recovery === null}
            onClick={() => setOpen('recovery')}
          >
            {recovery?.enabled ? 'Replace' : 'Set up'}
          </button>
        </div>
      </div>

      {open === 'password' && (
        <ChangePasswordSheet
          session={session}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            setChanged(true);
          }}
        />
      )}
      {open === 'recovery' && (
        <RecoverySetupSheet
          session={session}
          replacing={recovery?.enabled ?? false}
          onClose={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function ChangePasswordSheet(props: {
  session: Session;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem =
      passwordProblem(next, confirm, props.session.email) ??
      (next === current ? 'Choose a password different from the current one.' : null);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changeMasterPassword(props.session, current, next);
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Change master password"
      subtitle="Your Secret Key and everything in your vault stay the same"
      icon={<Icon name="key" size={18} />}
      onClose={props.onClose}
      width={480}
    >
      <form className="sheet-form" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <Field
            label="Current master password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
            autoFocus
          />
          <Field
            label="New master password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={setNext}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few random words works well.`}
          />
          <Field
            label="Confirm new master password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
        </fieldset>
        <p className="notice">
          <Icon name="device" size={15} />
          Your other devices are signed out. Sign in there again with the new password.
        </p>
        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function RecoverySetupSheet(props: { session: Session; replacing: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const close = () => {
    void core.discardRecoveryCode();
    props.onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCode(await setUpRecovery(props.session, password));
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={props.replacing ? 'Replace recovery code' : 'Set up a recovery code'}
      subtitle="Your way back in if you forget your master password"
      icon={<Icon name="shield" size={18} />}
      onClose={close}
      width={520}
    >
      {code ? (
        <div className="sheet-form">
          <RecoveryCodeCard code={code} />
          <label className="check panel panel-pad">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>I saved my recovery code somewhere safe. Zvault can&apos;t show it again.</span>
          </label>
          <div className="sheet-actions">
            <button type="button" className="primary" disabled={!confirmed} onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="sheet-form" onSubmit={(e) => void submit(e)}>
          <p className="secondary" style={{ margin: 0 }}>
            Zvault makes a code on this Mac that can unlock your account with your email. We never
            see it, so it keeps your vault end-to-end encrypted.
            {props.replacing && ' Your current recovery code stops working.'}
          </p>
          <fieldset disabled={busy}>
            <Field
              label="Master password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
              autoFocus
            />
          </fieldset>
          <ErrorLine error={error} />
          <div className="sheet-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Making your code…' : props.replacing ? 'Replace code' : 'Make recovery code'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

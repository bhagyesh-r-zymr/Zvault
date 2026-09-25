import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { RecoveryCodeCard } from '../account/RecoveryCodeCard.js';
import '../account/account.css';
import {
  finishRecovery,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  prepareRecovery,
  verifyRecovery,
  type Session,
  type VerifiedRecovery,
} from '../auth.js';
import { core, type RecoveredAccount } from '../core.js';
import { parseProof } from '../two-factor/proof.js';
import { ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { Field, Form } from './Form.js';

/** Step 1: which account, and a code sent to its email. */
export function RecoverEmail(props: {
  email?: string;
  onSent: (email: string) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(props.email ?? '');
  return (
    <Form
      title="Forgot your master password?"
      intro="You can get back in with the recovery code you saved from Settings. We'll email you a code first."
      submitLabel="Email me a code"
      busyLabel="Sending…"
      onSubmit={async () => {
        const normalized = email.trim().toLowerCase();
        await api.recoverStart(normalized);
        props.onSent(normalized);
      }}
      footer={
        <button type="button" className="link" onClick={props.onBack}>
          Back to sign in
        </button>
      }
    >
      <Field
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="username"
        value={email}
        onChange={setEmail}
        autoFocus={!props.email}
      />
      <p className="notice">
        <Icon name="shield" size={15} />
        No recovery code? Zvault can&apos;t see your data, so without your master password and
        Secret Key it can&apos;t be opened.
      </p>
    </Form>
  );
}

const RESEND_SECONDS = 60;

/** Step 2: the emailed code and the recovery code, checked together. */
export function RecoverCodes(props: {
  email: string;
  onVerified: (verified: VerifiedRecovery) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [wait, setWait] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  return (
    <Form
      title="Enter your codes"
      intro={
        <>
          We sent a code to <strong>{props.email}</strong>. It expires in 15 minutes.
        </>
      }
      submitLabel="Continue"
      busyLabel="Checking…"
      onSubmit={async () => {
        props.onVerified(await verifyRecovery(props.email, code.replace(/\D/g, ''), recoveryCode));
      }}
      footer={
        <>
          <button
            type="button"
            className="link"
            disabled={wait > 0}
            onClick={() => {
              setWait(RESEND_SECONDS);
              void api.recoverStart(props.email);
            }}
          >
            {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
          </button>
          <button type="button" className="link" onClick={props.onBack}>
            Back to sign in
          </button>
        </>
      }
    >
      <Field
        label="Code from your email"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        mono
        placeholder="123 456"
        value={code}
        onChange={setCode}
        autoFocus
      />
      <Field
        label="Recovery code"
        mono
        placeholder="R1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        value={recoveryCode}
        onChange={setRecoveryCode}
        hint="It's on your Recovery Kit. Letters aren't case sensitive."
      />
    </Form>
  );
}

/** Step 3: a new master password, and a 2FA code when the account has 2FA on. */
export function RecoverPassword(props: {
  verified: VerifiedRecovery;
  onRecovered: (result: { session: Session; recoveryCode: string }) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [twoFactor, setTwoFactor] = useState('');
  // Kept so a mistyped 2FA code can be retried without making new keys.
  const [prepared, setPrepared] = useState<{ password: string; account: RecoveredAccount } | null>(
    null,
  );

  return (
    <Form
      title="Choose a new master password"
      intro="You'll also get a new Secret Key and a new recovery code. Everything in your vault stays."
      submitLabel="Reset and unlock"
      busyLabel="Making your new keys…"
      onSubmit={async () => {
        const problem = passwordProblem(password, confirm, props.verified.email);
        if (problem) throw new Error(problem);
        const typed = twoFactor.replace(/\s/g, '');
        const proof = props.verified.twoFactorRequired
          ? (parseProof(typed, 'code') ?? parseProof(twoFactor.trim(), 'recovery'))
          : undefined;
        if (props.verified.twoFactorRequired && !proof) {
          throw new Error(
            'Enter the 6-digit code from your authenticator app, or a 2FA recovery code.',
          );
        }
        const account =
          prepared?.password === password
            ? prepared.account
            : await prepareRecovery(props.verified, password);
        setPrepared({ password, account });
        props.onRecovered(await finishRecovery(props.verified, account, proof ?? undefined));
      }}
      footer={
        <button type="button" className="link" onClick={props.onBack}>
          Cancel
        </button>
      }
    >
      <Field
        label="New master password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few random words works well.`}
        autoFocus
      />
      <Field
        label="Confirm new master password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
      />
      {props.verified.twoFactorRequired && (
        <Field
          label="Two-step sign-in code"
          inputMode="numeric"
          autoComplete="one-time-code"
          mono
          placeholder="123 456"
          value={twoFactor}
          onChange={setTwoFactor}
          hint="From your authenticator app, or one of your 2FA recovery codes."
        />
      )}
    </Form>
  );
}

/**
 * After a recovery: the account has a new Secret Key and recovery code.
 * Both are saved here before the vault opens.
 */
export function RecoveredKits(props: { email: string; recoveryCode: string; onDone: () => void }) {
  const [kitSaved, setKitSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const saveKit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (await core.saveEmergencyKit(props.email)) setKitSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    await Promise.all([core.discardEmergencyKit(), core.discardRecoveryCode()]).catch(
      () => undefined,
    );
    props.onDone();
  };

  return (
    <div className="kit-layout">
      <section className="kit-side" aria-labelledby="recovered-title">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="pill secure" style={{ alignSelf: 'flex-start' }}>
            <Icon name="shieldCheck" size={13} /> Account recovered
          </span>
          <h1 id="recovered-title">Save your new kits</h1>
          <p className="secondary" style={{ fontSize: 15, lineHeight: 1.55 }}>
            Your old Secret Key and recovery code no longer work, and your other devices were signed
            out. Save both new ones now: Zvault never sees them, so it can&apos;t show them again.
          </p>
        </div>

        <div className="recover-codes">
          <div className="recovery-card">
            <span className="eyebrow">1 · New Emergency Kit</span>
            <span className="secondary">
              Holds your new Secret Key. Use it with your new master password on other devices.
            </span>
            <div className="recovery-card-actions">
              <button
                type="button"
                className={kitSaved ? undefined : 'primary'}
                disabled={saving}
                onClick={() => void saveKit()}
              >
                <Icon name="download" size={14} />
                {saving ? 'Saving…' : kitSaved ? 'Save another copy' : 'Save Emergency Kit PDF'}
              </button>
            </div>
            <ErrorLine error={error} />
          </div>
          <span className="eyebrow">2 · New recovery code</span>
          <RecoveryCodeCard code={props.recoveryCode} />
        </div>

        <label className="check panel panel-pad" style={{ padding: '14px 16px' }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>I saved my new Emergency Kit and recovery code in separate, safe places.</span>
        </label>
        <button
          type="button"
          className="primary large block"
          disabled={!confirmed || !kitSaved}
          onClick={() => void finish()}
        >
          Open my vault
        </button>
      </section>
      <div className="kit-preview" aria-hidden="true">
        <div className="kit-paper">
          <strong style={{ fontSize: 16 }}>Recovery Kit</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="k">Email</span>
            <span style={{ fontSize: 15 }}>{props.email}</span>
          </div>
          <div className="key-box">
            <span className="k">Recovery code</span>
            <span className="blur">Printed in the PDF you save</span>
          </div>
          <span className="note">Keep it apart from your Emergency Kit.</span>
        </div>
      </div>
    </div>
  );
}

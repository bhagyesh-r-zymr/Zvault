import type { TotpSetupResponse } from '@zvault/shared';
import { useState, type FormEvent } from 'react';
// Not the `qrcode` package: it assigns `exports.toString`, which throws under
// Tauri's freezePrototype and blanks the whole app on start.
import { renderSVG } from 'uqr';
import { describeError, type TwoFactorApi } from './api.js';
import { CodeInput } from './CodeInput.js';
import { parseProof } from './proof.js';
import { RecoveryCodes } from './RecoveryCodes.js';

interface Props {
  api: TwoFactorApi;
  /** Email of the signed-in account, used in the downloaded codes file. */
  account: string;
  onEnabled: () => void;
  onCancel: () => void;
}

type Step =
  | { kind: 'intro' }
  | { kind: 'scan'; setup: TotpSetupResponse; qr: string }
  | { kind: 'codes'; recoveryCodes: string[] };

/** Groups a base32 secret in fours for manual entry. */
const groupSecret = (s: string) => s.match(/.{1,4}/g)?.join(' ') ?? s;

/**
 * Enrollment: fetch a secret, show it as a QR code rendered on-device (the
 * secret never goes to a third-party QR service), confirm with a first code,
 * then show recovery codes once.
 */
export function TwoFactorSetup({ api, account, onEnabled, onCancel }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [code, setCode] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const setup = await api.beginSetup();
      const svg = renderSVG(setup.otpauthUri, { ecc: 'M', border: 1 });
      setStep({ kind: 'scan', setup, qr: `data:image/svg+xml;base64,${btoa(svg)}` });
      setCode('');
      setShowSecret(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    const proof = parseProof(code, 'code');
    if (!proof || !('code' in proof)) return;
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes } = await api.confirmSetup(proof.code);
      setStep({ kind: 'codes', recoveryCodes });
    } catch (err) {
      setError(describeError(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error && (
    <p role="alert" className="error">
      {error}
    </p>
  );

  if (step.kind === 'codes') {
    return <RecoveryCodes codes={step.recoveryCodes} account={account} onDone={onEnabled} />;
  }

  if (step.kind === 'intro') {
    return (
      <section aria-labelledby="tfa-title" className="tfa-step">
        <h2 id="tfa-title">Turn on two-factor authentication</h2>
        <p>
          After you enter your master password, Zvault will also ask for a code from an
          authenticator app such as 1Password, Google Authenticator or Authy.
        </p>
        {errorLine}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Set up'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="tfa-scan-title" className="tfa-step">
      <h2 id="tfa-scan-title">Scan this QR code</h2>
      <p>Open your authenticator app, add an account, and scan the code.</p>
      <img className="qr" src={step.qr} alt="QR code for your authenticator app" />
      {showSecret ? (
        <p>
          Or enter this key: <code className="secret">{groupSecret(step.setup.secret)}</code>
        </p>
      ) : (
        <button type="button" className="link" onClick={() => setShowSecret(true)}>
          Can’t scan? Enter a key instead
        </button>
      )}
      <form onSubmit={(e) => void confirm(e)} className="tfa">
        <p>Enter the 6-digit code your app shows to finish.</p>
        <CodeInput mode="code" value={code} onChange={setCode} disabled={busy} />
        {errorLine}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || parseProof(code, 'code') === null}
          >
            {busy ? 'Checking…' : 'Turn on'}
          </button>
        </div>
      </form>
    </section>
  );
}

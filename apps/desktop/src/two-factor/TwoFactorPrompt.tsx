import type { TwoFactorProof } from '@zvault/shared';
import { useState, type FormEvent } from 'react';
import { describeError } from './api.js';
import { CodeInput } from './CodeInput.js';
import { parseProof } from './proof.js';

interface Props {
  /** Sends the proof to the login flow's 2FA step; rejects if it was refused. */
  onSubmit: (proof: TwoFactorProof) => Promise<void>;
  onCancel: () => void;
  title?: string;
}

/**
 * Asks for the second factor: a TOTP code, or a recovery code when the
 * authenticator is unavailable. Used at sign-in and before sensitive 2FA
 * changes.
 */
export function TwoFactorPrompt({
  onSubmit,
  onCancel,
  title = 'Two-factor authentication',
}: Props) {
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proof = parseProof(value, mode);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!proof) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(proof);
    } catch (err) {
      setError(describeError(err));
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'code' ? 'recovery' : 'code');
    setValue('');
    setError(null);
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby="tfa-prompt-title" className="tfa-step">
      <h2 id="tfa-prompt-title">{title}</h2>
      <p>
        {mode === 'code'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Enter one of the recovery codes you saved. Each works once.'}
      </p>
      <CodeInput key={mode} mode={mode} value={value} onChange={setValue} disabled={busy} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" className="link" onClick={switchMode} disabled={busy}>
        {mode === 'code' ? 'Use a recovery code' : 'Use your authenticator app'}
      </button>
      <div className="actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || proof === null}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

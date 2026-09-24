import { useCallback, useEffect, useState } from 'react';
import { otpCore as defaultCore, type OtpCore, type OtpSetup } from './core.js';
import { Icon } from '../ui/Icon.js';
import { OneTimePasswordCode } from './OneTimePasswordCode.js';
import './otp.css';

interface Props {
  /** The item's `totp` field: an `otpauth://totp/` URI, or ''. */
  value: string;
  onChange: (uri: string) => void;
  core?: OtpCore;
}

/**
 * Adds, shows or removes an item's one-time password, like 1Password: scan
 * the QR code on screen, pick an image of it, or paste the link or setup key.
 * The code preview is computed in Rust from the unsaved value.
 */
export function OneTimePasswordEditor({ value, onChange, core = defaultCore }: Props) {
  const [setup, setSetup] = useState<OtpSetup | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Describe an existing value (opening an item for editing).
  useEffect(() => {
    if (!value) {
      setSetup(null);
      return;
    }
    if (setup?.uri === value) return;
    core.parse(value).then(setSetup, (e: unknown) => setError(String(e)));
  }, [value, setup, core]);

  const getCode = useCallback(() => core.parse(value).then((s) => s.current), [core, value]);

  const run = (read: () => Promise<OtpSetup | null>) => {
    setBusy(true);
    setError(null);
    read()
      .then((s) => {
        if (!s) return;
        setSetup(s);
        setTyped('');
        onChange(s.uri);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  if (value && setup) {
    const label = [setup.issuer, setup.account].filter(Boolean).join(' · ');
    return (
      <div className="otp-editor otp-editor-set">
        <OneTimePasswordCode key={setup.uri} getCode={getCode} />
        <span className="muted">{label}</span>
        <button type="button" className="small ghost" onClick={() => onChange('')}>
          <Icon name="trash" size={13} /> Remove
        </button>
      </div>
    );
  }

  return (
    <div className="otp-editor">
      <div className="otp-actions">
        <button
          type="button"
          className="small"
          onClick={() => run(core.scanScreen)}
          disabled={busy}
        >
          <Icon name="search" size={13} /> Scan QR code on screen
        </button>
        <button type="button" className="small" onClick={() => run(core.scanImage)} disabled={busy}>
          <Icon name="download" size={13} /> Choose QR image…
        </button>
      </div>
      <div className="otp-actions">
        <input
          aria-label="Setup key or otpauth link"
          placeholder="Or paste the setup key or otpauth:// link"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <button
          type="button"
          className="primary"
          onClick={() => run(() => core.parse(typed))}
          disabled={busy || !typed.trim()}
        >
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className="error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

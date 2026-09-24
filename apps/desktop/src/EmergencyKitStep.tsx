import { useState } from 'react';
import { core } from './core.js';

interface Props {
  /** The account email, printed on the kit. */
  email: string;
  /** Called once the kit is saved and the person has confirmed it. */
  onDone: () => void;
}

/**
 * Sign-up step that saves the Emergency Kit. Mount it after the account is
 * created and the Rust side has staged the new Secret Key with
 * `stage_secret_key`. The key itself stays in Rust: this component only asks
 * for the PDF to be written to a file the person picks.
 */
export function EmergencyKitStep({ email, onDone }: Props) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (await core.saveEmergencyKit(email)) setSaved(true);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    try {
      await core.discardEmergencyKit();
      onDone();
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  return (
    <section className="emergency-kit" aria-labelledby="emergency-kit-title">
      <h2 id="emergency-kit-title">Save your Emergency Kit</h2>
      <p>
        Your Emergency Kit has your Secret Key, which you need with your master password to sign in
        on a new device. It was created on this Mac and Zvault never sees it, so we can&apos;t send
        you another copy.
      </p>
      <button type="button" onClick={() => void save()} disabled={saving}>
        {saving ? 'Saving…' : saved ? 'Save another copy' : 'Save Emergency Kit PDF'}
      </button>
      {error && <p role="alert">{error}</p>}
      {saved && (
        <>
          <p>Print it, write your master password in the box, and keep it somewhere safe.</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I&apos;ve saved my Emergency Kit somewhere safe
          </label>
          <button type="button" onClick={() => void finish()} disabled={!confirmed}>
            Continue
          </button>
        </>
      )}
    </section>
  );
}

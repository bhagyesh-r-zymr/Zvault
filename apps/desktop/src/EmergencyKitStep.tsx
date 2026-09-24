import { useState } from 'react';
import { core } from './core.js';
import { SignupSteps } from './screens/Form.js';
import { ErrorLine } from './ui/controls.js';
import { BrandMark, Icon } from './ui/Icon.js';

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
 * for the PDF to be written to a file the person picks, and the preview on
 * the right never shows it.
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
    <div className="kit-layout">
      <section className="kit-side" aria-labelledby="emergency-kit-title">
        <SignupSteps current="Emergency Kit" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 id="emergency-kit-title" style={{ fontSize: 32 }}>
            Save your Emergency Kit
          </h1>
          <p className="secondary" style={{ fontSize: 15, lineHeight: 1.55 }}>
            It holds your Secret Key. You need it, plus your master password, to sign in on a new
            device. It was created on this Mac and Zvault never sees it, so we can&apos;t send you
            another copy.
          </p>
        </div>
        <button
          type="button"
          className={saved ? 'large block' : 'primary large block'}
          onClick={() => void save()}
          disabled={saving}
        >
          <Icon name="download" size={18} />
          {saving ? 'Saving…' : saved ? 'Save another copy' : 'Save Emergency Kit PDF'}
        </button>
        <ErrorLine error={error} />
        {saved && (
          <>
            <p className="notice">
              <Icon name="shieldCheck" size={15} />
              Saved. Print it, write your master password in the box by hand, and keep it somewhere
              safe.
            </p>
            <label className="check panel panel-pad" style={{ padding: '14px 16px' }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I saved it somewhere safe, like a drawer at home or another locked place.</span>
            </label>
            <button
              type="button"
              className="primary large block"
              onClick={() => void finish()}
              disabled={!confirmed}
            >
              Continue to sign in
            </button>
          </>
        )}
      </section>
      <div className="kit-preview" aria-hidden="true">
        <div className="kit-paper">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandMark size={30} />
            <strong style={{ fontSize: 16, flexGrow: 1 }}>Emergency Kit</strong>
            <span className="k" style={{ letterSpacing: 0, textTransform: 'none' }}>
              {new Date().toLocaleDateString()}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="k">Email</span>
            <span style={{ fontSize: 15 }}>{email}</span>
          </div>
          <div className="key-box">
            <span className="k">Secret Key</span>
            <span className="blur">Printed only in the PDF you save</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="k">Master password</span>
            <div className="write-box" />
            <span style={{ fontSize: 11, color: '#5b6272' }}>
              Write it by hand. Never type it into the file.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

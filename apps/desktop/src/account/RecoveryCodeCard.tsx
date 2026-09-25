import { useState } from 'react';
import { errorMessage } from '../auth.js';
import { core } from '../core.js';
import { CopyButton, ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/**
 * A new recovery code, shown once, with a Recovery Kit PDF to save. The code
 * is also staged in Rust for the PDF until the caller discards it.
 */
export function RecoveryCodeCard(props: { code: string; label?: string; onSaved?: () => void }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (await core.saveRecoveryKit()) {
        setSaved(true);
        props.onSaved?.();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="recovery-card">
      <span className="eyebrow">{props.label ?? 'Recovery code'}</span>
      <code className="recovery-code" aria-label="Recovery code">
        {props.code}
      </code>
      <div className="recovery-card-actions">
        <button
          type="button"
          className={saved ? undefined : 'primary'}
          disabled={saving}
          onClick={() => void save()}
        >
          <Icon name="download" size={14} />
          {saving ? 'Saving…' : saved ? 'Save another copy' : 'Save Recovery Kit PDF'}
        </button>
        <CopyButton value={props.code} className="" />
      </div>
      <ErrorLine error={error} />
      <p className="notice">
        <Icon name="shieldCheck" size={15} />
        Made on this Mac and never sent to Zvault. Keep it apart from your Emergency Kit.
      </p>
    </div>
  );
}

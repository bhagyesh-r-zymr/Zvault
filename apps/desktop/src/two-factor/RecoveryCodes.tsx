import { useState } from 'react';
import { recoveryCodesFile } from './proof.js';

interface Props {
  codes: readonly string[];
  account: string;
  onDone: () => void;
}

/** Shows new recovery codes once and makes the user confirm they saved them. */
export function RecoveryCodes({ codes, account, onDone }: Props) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = recoveryCodesFile(codes, account);

  const copy = () => {
    navigator.clipboard.writeText(codes.join('\n')).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zvault-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="recovery-title">
      <h2 id="recovery-title">Save your recovery codes</h2>
      <p>
        If you lose your authenticator, each of these codes lets you sign in once. This is the only
        time Zvault will show them.
      </p>
      <ol className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download}>
          Download
        </button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I
        saved these codes somewhere safe
      </label>
      <div className="actions">
        <button type="button" className="primary" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

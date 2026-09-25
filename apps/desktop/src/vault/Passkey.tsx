import { useState } from 'react';
import { CopyButton, ErrorLine, Segmented } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { PasskeyFields } from './core.js';
import type { VaultSync } from './sync.js';

/** Shortens a long base64url id for display: `q8Rz…4fXw`. */
function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function created(at: number | undefined): string {
  if (!at) return '—';
  return new Date(at * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * An item's passkey. The private key stays in Rust: this shows only public
 * details, and "Test sign-in" asks Rust to sign a fresh challenge and check
 * it with the public key, as the website would.
 */
export function PasskeyPanel({
  passkey,
  onTest,
}: {
  passkey: PasskeyFields;
  onTest: () => Promise<void>;
}) {
  const [test, setTest] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setTest('running');
    setError(null);
    onTest().then(
      () => setTest('ok'),
      (e: unknown) => {
        setTest('failed');
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  return (
    <div className="panel passkey-panel">
      <div className="passkey-head">
        <span className="passkey-icon">
          <Icon name="passkey" size={18} />
        </span>
        <div className="row-main">
          <span className="row-title">Passkey</span>
          <span className="row-sub">Sign in to {passkey.rpId} without a password</span>
        </div>
        <button type="button" className="small" onClick={run} disabled={test === 'running'}>
          <Icon name="shieldCheck" size={13} />
          {test === 'running' ? 'Signing…' : 'Test sign-in'}
        </button>
      </div>
      {test === 'ok' && (
        <p className="passkey-ok" role="status">
          <Icon name="check" size={13} strokeWidth={2.6} />
          Signed a fresh challenge for {passkey.rpId} and verified it with the public key.
        </p>
      )}
      <ErrorLine error={error} />
      <div className="rows">
        <div className="row">
          <div className="row-main">
            <span className="row-label">website</span>
            <span className="field-value link">{passkey.rpId}</span>
          </div>
          <CopyButton value={passkey.rpId} secret={false} />
        </div>
        <div className="row">
          <div className="row-main">
            <span className="row-label">user name</span>
            <span className="field-value">{passkey.userName}</span>
          </div>
          <CopyButton value={passkey.userName} secret={false} />
        </div>
        <div className="row">
          <div className="row-main">
            <span className="row-label">credential id</span>
            <code className="field-value" title={passkey.credentialId}>
              {shortId(passkey.credentialId ?? '')}
            </code>
          </div>
          <CopyButton value={passkey.credentialId ?? ''} secret={false} />
        </div>
        <div className="row">
          <div className="row-main">
            <span className="row-label">public key · ES256</span>
            <code className="field-value" title={passkey.publicKey}>
              {shortId(passkey.publicKey ?? '')}
            </code>
          </div>
          <CopyButton value={passkey.publicKey ?? ''} secret={false} />
        </div>
        <div className="row">
          <div className="row-main">
            <span className="row-label">private key</span>
            <span className="muted">
              <Icon name="lock" size={12} /> Encrypted in this item, never shown
            </span>
          </div>
          <span className="row-sub">Created {created(passkey.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

type Mode = 'create' | 'import';

/** New passkey: create a fresh key pair for a site, or import an existing one. */
export function PasskeyEditor({
  sync,
  onDone,
}: {
  sync: VaultSync;
  onDone: (id: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('create');
  const [title, setTitle] = useState('');
  const [website, setWebsite] = useState('');
  const [userName, setUserName] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [userHandle, setUserHandle] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const site = website.trim();
  const url = site && !/^https?:\/\//i.test(site) ? `https://${site}` : site;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const passkey: PasskeyFields =
      mode === 'create'
        ? { rpId: site, userName }
        : { rpId: site, userName, credentialId, userHandle, privateKey };
    sync
      .save(null, {
        title: title.trim() || site.replace(/^https?:\/\//i, '').split('/')[0] || 'Passkey',
        username: userName,
        password: '',
        urls: url ? [url] : [],
        notes,
        totp: '',
        passkey,
      })
      .then(onDone, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className="detail-body item-form" onSubmit={submit}>
      <div className="item-head">
        <span className="passkey-icon large">
          <Icon name="passkey" size={24} />
        </span>
        <div>
          <h1>New passkey</h1>
          <span className="row-sub">
            Stored end-to-end encrypted, like every item. The private key never leaves your devices
            unencrypted.
          </span>
        </div>
      </div>
      <Segmented
        label="How to add the passkey"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'create', label: 'Create new' },
          { value: 'import', label: 'Import existing' },
        ]}
      />
      <div className="grid-2">
        <label className="field">
          <span>Website</span>
          <input
            required
            autoFocus
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="github.com"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>User name</span>
          <input
            required
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
          />
        </label>
      </div>
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={site.replace(/^https?:\/\//i, '').split('/')[0] || 'GitHub'}
        />
      </label>
      {mode === 'import' ? (
        <>
          <div className="grid-2">
            <label className="field">
              <span>Credential ID (base64url)</span>
              <input
                required
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>User handle (optional)</span>
              <input
                value={userHandle}
                onChange={(e) => setUserHandle(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <label className="field">
            <span>Private key (PKCS#8 PEM or base64, ES256)</span>
            <textarea
              required
              className="mono"
              rows={4}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              spellCheck={false}
            />
          </label>
        </>
      ) : (
        <p className="preview-note">
          <Icon name="wand" size={16} />
          <span>
            Zvault creates a new <strong>ES256</strong> key pair and credential ID for this site.
            Test it with Test sign-in once it&apos;s saved.
          </span>
        </p>
      )}
      <label className="field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </label>
      <ErrorLine error={error} />
      <div className="actions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create passkey' : 'Import passkey'}
        </button>
      </div>
    </form>
  );
}

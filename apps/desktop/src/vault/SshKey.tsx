import { useState } from 'react';
import { CopyButton, ErrorLine, Segmented } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { SshKeyFields } from './core.js';
import type { VaultSync } from './sync.js';

/** Where the Mac app's SSH agent listens. Matches `ssh_agent::socket_path`. */
export const SSH_AGENT_SOCKET = '~/.zvault/ssh-agent.sock';

function created(at: number | undefined): string {
  if (!at) return '—';
  return new Date(at * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * An item's SSH key. The private key stays in Rust: this shows the public
 * key to paste into GitHub or `authorized_keys`, and its fingerprint.
 */
export function SshKeyPanel({ sshKey }: { sshKey: SshKeyFields }) {
  return (
    <div className="panel passkey-panel">
      <div className="passkey-head">
        <span className="passkey-icon">
          <Icon name="terminal" size={18} />
        </span>
        <div className="row-main">
          <span className="row-title">SSH key · {sshKey.keyType}</span>
          <span className="row-sub">
            Signs for ssh and git through Zvault&apos;s SSH agent, after you approve each use
          </span>
        </div>
      </div>
      <div className="rows">
        <div className="row">
          <div className="row-main">
            <span className="row-label">public key</span>
            <code className="field-value ssh-public-key">{sshKey.publicKey}</code>
          </div>
          <CopyButton value={sshKey.publicKey ?? ''} secret={false} />
        </div>
        <div className="row">
          <div className="row-main">
            <span className="row-label">fingerprint</span>
            <code className="field-value">{sshKey.fingerprint}</code>
          </div>
          <CopyButton value={sshKey.fingerprint ?? ''} secret={false} />
        </div>
        {sshKey.comment && (
          <div className="row">
            <div className="row-main">
              <span className="row-label">key name</span>
              <span className="field-value">{sshKey.comment}</span>
            </div>
          </div>
        )}
        <div className="row">
          <div className="row-main">
            <span className="row-label">private key</span>
            <span className="muted">
              <Icon name="lock" size={12} /> Encrypted in this item, never shown
            </span>
          </div>
          <span className="row-sub">Created {created(sshKey.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

type Mode = 'create' | 'import';

/** New SSH key: generate an Ed25519 key, or import an OpenSSH private key. */
export function SshKeyEditor({
  sync,
  onDone,
}: {
  sync: VaultSync;
  onDone: (id: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('create');
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const name = title.trim() || 'SSH key';
    const sshKey: SshKeyFields =
      mode === 'create'
        ? { comment: comment.trim() || name }
        : { comment: comment.trim(), privateKey, passphrase };
    sync
      .save(null, {
        title: name,
        username: '',
        password: '',
        urls: [],
        notes,
        totp: '',
        sshKey,
      })
      .then(onDone, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className="detail-body item-form" onSubmit={submit}>
      <div className="item-head">
        <span className="passkey-icon large">
          <Icon name="terminal" size={24} />
        </span>
        <div>
          <h1>New SSH key</h1>
          <span className="row-sub">
            Stored end-to-end encrypted, like every item. The private key never leaves your devices
            unencrypted.
          </span>
        </div>
      </div>
      <Segmented
        label="How to add the SSH key"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'create', label: 'Generate new' },
          { value: 'import', label: 'Import existing' },
        ]}
      />
      <div className="grid-2">
        <label className="field">
          <span>Title</span>
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="GitHub"
          />
        </label>
        <label className="field">
          <span>Key name (optional)</span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={mode === 'create' ? title.trim() || 'you@laptop' : 'Keep the key’s own'}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      {mode === 'import' ? (
        <>
          <label className="field">
            <span>Private key (OpenSSH, such as ~/.ssh/id_ed25519)</span>
            <textarea
              required
              className="mono"
              rows={6}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Passphrase (if the key has one)</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
            />
            <span className="hint">
              Used once to unlock the key. Zvault keeps the key encrypted with your vault instead.
            </span>
          </label>
        </>
      ) : (
        <p className="preview-note">
          <Icon name="wand" size={16} />
          <span>
            Zvault creates a new <strong>Ed25519</strong> key. Copy its public key into GitHub or a
            server&apos;s authorized_keys once it&apos;s saved.
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
          {busy ? 'Saving…' : mode === 'create' ? 'Generate key' : 'Import key'}
        </button>
      </div>
    </form>
  );
}

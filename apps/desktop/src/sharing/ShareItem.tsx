import { SHARE_LIMITS, type SharedItemPayload, type SharingKeyResponse } from '@zvault/shared';
import { useState } from 'react';
import { SHARE_ORIGIN, type SharingApi } from './api.js';
import { sharingCore } from './core.js';

const DAY = 24 * 60 * 60;
const EXPIRY_OPTIONS = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: DAY },
  { label: '7 days', seconds: 7 * DAY },
  { label: '30 days', seconds: 30 * DAY },
] as const;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Share one item by link or with another Zvault user. */
export function ShareItem({ item, api }: { item: SharedItemPayload; api: SharingApi }) {
  const [mode, setMode] = useState<'link' | 'person'>('link');
  return (
    <section className="share">
      <div role="tablist" className="tabs">
        <button role="tab" aria-selected={mode === 'link'} onClick={() => setMode('link')}>
          Secure link
        </button>
        <button role="tab" aria-selected={mode === 'person'} onClick={() => setMode('person')}>
          Zvault user
        </button>
      </div>
      {mode === 'link' ? (
        <ShareByLink item={item} api={api} />
      ) : (
        <ShareWithPerson item={item} api={api} />
      )}
    </section>
  );
}

function ShareByLink({ item, api }: { item: SharedItemPayload; api: SharingApi }) {
  const [expiresInSeconds, setExpiry] = useState<number>(DAY);
  const [maxViews, setMaxViews] = useState(1);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const link = await sharingCore.createLink(item, SHARE_ORIGIN);
      // The URL (and its key) stays here; the API gets ciphertext and a verifier.
      await api.createLink({
        id: link.id,
        verifier: link.verifier,
        blob: link.blob,
        expiresInSeconds,
        maxViews,
      });
      setUrl(link.url);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (url) {
    return (
      <div>
        <p>Anyone with this link can view the item. It is shown only now.</p>
        <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.target.select()} />
        <button onClick={() => void navigator.clipboard.writeText(url)}>Copy link</button>
        <p className="hint">
          Send it through a channel you trust. It stops working after {maxViews}{' '}
          {maxViews === 1 ? 'view' : 'views'} or when it expires.
        </p>
        <button onClick={() => setUrl(null)}>Done</button>
      </div>
    );
  }

  return (
    <div>
      <label>
        Expires after{' '}
        <select value={expiresInSeconds} onChange={(e) => setExpiry(Number(e.target.value))}>
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.seconds} value={o.seconds}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Views allowed{' '}
        <input
          type="number"
          min={1}
          max={SHARE_LIMITS.maxViews}
          value={maxViews}
          onChange={(e) =>
            setMaxViews(Math.min(SHARE_LIMITS.maxViews, Math.max(1, Number(e.target.value) || 1)))
          }
        />
      </label>
      <button disabled={busy} onClick={() => void create()}>
        Create link
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function ShareWithPerson({ item, api }: { item: SharedItemPayload; api: SharingApi }) {
  const [email, setEmail] = useState('');
  const [recipient, setRecipient] = useState<(SharingKeyResponse & { fingerprint: string }) | null>(
    null,
  );
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const lookUp = () =>
    run(async () => {
      const key = await api.lookupKey(email.trim());
      setRecipient({ ...key, fingerprint: await sharingCore.fingerprint(key.publicKey) });
    });

  const send = () =>
    run(async () => {
      if (!recipient) return;
      const me = await sharingCore.identity();
      await api.publishKey(me.publicKey);
      const sealed = await sharingCore.sealTo(recipient.publicKey, item);
      await api.shareWithUser({
        id: sealed.id,
        recipientEmail: recipient.email,
        recipientPublicKey: recipient.publicKey,
        senderPublicKey: sealed.senderPublicKey,
        ephemeralPublicKey: sealed.ephemeralPublicKey,
        blob: sealed.blob,
      });
      setSentTo(recipient.email);
      setRecipient(null);
      setEmail('');
    });

  if (sentTo) {
    return (
      <div>
        <p>Shared with {sentTo}. They will get an email and see it in Zvault.</p>
        <button onClick={() => setSentTo(null)}>Share with someone else</button>
      </div>
    );
  }

  return (
    <div>
      <label>
        Email{' '}
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setRecipient(null);
          }}
        />
      </label>
      {!recipient ? (
        <button disabled={busy || !email.includes('@')} onClick={() => void lookUp()}>
          Find
        </button>
      ) : (
        <div>
          <p>
            Security code for {recipient.email}: <code>{recipient.fingerprint}</code>
          </p>
          <p className="hint">
            For sensitive items, ask them to read out the code in their Zvault settings. If it
            differs, do not send.
          </p>
          <button disabled={busy} onClick={() => void send()}>
            Share with {recipient.email}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

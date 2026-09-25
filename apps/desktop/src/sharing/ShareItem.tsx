import { SHARE_LIMITS, type SharedItemPayload, type SharingKeyResponse } from '@zvault/shared';
import { useState } from 'react';
import { ErrorLine, Segmented } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { SHARE_ORIGIN, type SharingApi } from './api.js';
import { sharingCore } from './core.js';
import { parseEmails } from './emails.js';
import { checkPin, pinKey, type PinCheck } from './pins.js';

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
      <Segmented
        large
        label="Share with"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'link', label: 'Secure link' },
          { value: 'person', label: 'A Zvault user' },
        ]}
      />
      {mode === 'link' ? (
        <ShareByLink item={item} api={api} />
      ) : (
        <ShareWithPerson item={item} api={api} />
      )}
    </section>
  );
}

function ShareByLink({ item, api }: { item: SharedItemPayload; api: SharingApi }) {
  const [expiresInSeconds, setExpiry] = useState<number>(7 * DAY);
  const [maxViews, setMaxViews] = useState(1);
  const [audience, setAudience] = useState<'anyone' | 'emails'>('anyone');
  const [emailText, setEmailText] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    let allowedEmails: string[] | undefined;
    if (audience === 'emails') {
      const parsed = parseEmails(emailText);
      if ('error' in parsed) return setError(parsed.error);
      allowedEmails = parsed.emails;
    }
    setBusy(true);
    try {
      const link = await sharingCore.createLink(item, SHARE_ORIGIN);
      // The URL (and its key) stays here; the API gets ciphertext, a verifier
      // and, for a restricted link, the emails allowed to ask for a code.
      await api.createLink({
        id: link.id,
        verifier: link.verifier,
        blob: link.blob,
        expiresInSeconds,
        maxViews,
        allowedEmails,
      });
      setUrl(link.url);
      setAllowed(allowedEmails ?? null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function emailLink(to: string[], link: string) {
    setError(null);
    try {
      await sharingCore.composeEmail(
        to,
        `I shared "${item.title}" with you`,
        [
          `I shared "${item.title}" with you using Zvault.`,
          '',
          `Open this link: ${link}`,
          '',
          'Enter this email address on the page and Zvault will email you a one-time code. You do not need a Zvault account.',
        ].join('\n'),
      );
    } catch (e) {
      setError(message(e));
    }
  }

  if (url) {
    return (
      <div className="share-body">
        <p className="secondary">
          {allowed
            ? `Only ${allowed.join(', ')} can open this link, after confirming their email with a one-time code. It is shown only now.`
            : 'Anyone with this link can view the item. It is shown only now.'}
        </p>
        <div className="link-box">
          <input
            readOnly
            value={url}
            aria-label="Share link"
            className="mono"
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="primary"
            onClick={() => void navigator.clipboard.writeText(url)}
          >
            Copy link
          </button>
        </div>
        <p className="notice">
          <Icon name="shield" size={14} />
          The key is in the part after #, which browsers never send to our servers. It stops working
          after {maxViews} {maxViews === 1 ? 'view' : 'views'} or when it expires.
        </p>
        <ErrorLine error={error} />
        <div className="sheet-actions">
          {allowed && (
            <button type="button" onClick={() => void emailLink(allowed, url)}>
              <Icon name="mail" size={14} />
              Email the link
            </button>
          )}
          <button type="button" onClick={() => setUrl(null)}>
            Make another link
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="share-body">
      <div className="field">
        <span>Link expires after</span>
        <Segmented
          label="Link expires after"
          value={expiresInSeconds}
          onChange={setExpiry}
          options={EXPIRY_OPTIONS.map((o) => ({ value: o.seconds, label: o.label }))}
        />
      </div>
      <label className="field">
        <span>Views allowed</span>
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
      <div className="field">
        <span>Who can open it</span>
        <Segmented
          label="Who can open it"
          value={audience}
          onChange={setAudience}
          options={[
            { value: 'anyone', label: 'Anyone with the link' },
            { value: 'emails', label: 'Only people with these emails' },
          ]}
        />
      </div>
      {audience === 'emails' && (
        <label className="field">
          <span>Their emails</span>
          <textarea
            rows={2}
            value={emailText}
            placeholder="name@company.com, other@company.com"
            onChange={(e) => setEmailText(e.target.value)}
          />
          <span className="hint">
            They open the link, enter their email and type the one-time code Zvault emails them. No
            Zvault account needed.
          </span>
        </label>
      )}
      <ErrorLine error={error} />
      <button
        type="button"
        className="primary large block"
        disabled={busy}
        onClick={() => void create()}
      >
        <Icon name="link" size={15} />
        {busy ? 'Encrypting…' : 'Create secure link'}
      </button>
    </div>
  );
}

function ShareWithPerson({ item, api }: { item: SharedItemPayload; api: SharingApi }) {
  const [email, setEmail] = useState('');
  const [recipient, setRecipient] = useState<
    (SharingKeyResponse & { fingerprint: string; pin: PinCheck }) | null
  >(null);
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
      setRecipient({
        ...key,
        fingerprint: await sharingCore.fingerprint(key.publicKey),
        pin: checkPin(key.email, key.publicKey),
      });
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
      pinKey(recipient.email, recipient.publicKey);
      setSentTo(recipient.email);
      setRecipient(null);
      setEmail('');
    });

  if (sentTo) {
    return (
      <div className="share-body">
        <p className="notice">
          <Icon name="shieldCheck" size={15} />
          Shared with {sentTo}. They will get an email and see it in Zvault.
        </p>
        <div className="sheet-actions">
          <button type="button" onClick={() => setSentTo(null)}>
            Share with someone else
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="share-body">
      <label className="field">
        <span>Their Zvault email</span>
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
        <button
          type="button"
          className="primary large block"
          disabled={busy || !email.includes('@')}
          onClick={() => void lookUp()}
        >
          Find
        </button>
      ) : (
        <div className="share-body">
          <div
            className="panel panel-pad"
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <span className="row-label">Security code for {recipient.email}</span>
            <code className="secret" style={{ fontSize: 14 }}>
              {recipient.fingerprint}
            </code>
          </div>
          {recipient.pin === 'changed' && (
            <p role="alert" className="alert">
              This security code is different from the one {recipient.email} had before. Someone may
              be pretending to be them. Check the code with them before sending.
            </p>
          )}
          <p className="hint">
            For sensitive items, ask them to read out the code in their Zvault settings. If it
            differs, do not send.
          </p>
          <button
            type="button"
            className="primary large block"
            disabled={busy}
            onClick={() => void send()}
          >
            Share with {recipient.email}
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

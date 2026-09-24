import {
  SharedItemPayload,
  type IncomingUserShare,
  type OutgoingUserShare,
  type ShareLinkSummary,
} from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SharingApi } from './api.js';
import { CopyButton, ErrorLine, SecretText } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { sharingCore, type SharingIdentity } from './core.js';
import { checkPin, pinKey, type PinCheck } from './pins.js';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

/** Items shared with me, shares I've sent, and my active links. */
export function SharingCenter({ api }: { api: SharingApi }) {
  const [identity, setIdentity] = useState<SharingIdentity | null>(null);
  const [incoming, setIncoming] = useState<IncomingUserShare[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingUserShare[]>([]);
  const [links, setLinks] = useState<ShareLinkSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const me = await sharingCore.identity();
      setIdentity(me);
      await api.publishKey(me.publicKey);
      const [shares, linkList] = await Promise.all([api.listUserShares(), api.listLinks()]);
      setIncoming(shares.incoming);
      setOutgoing(shares.outgoing);
      setLinks(linkList.links);
    } catch (e) {
      setError(message(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = (fn: () => Promise<unknown>) => () =>
    void fn().then(refresh, (e: unknown) => setError(message(e)));

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Sharing</h1>
            <p>Items people shared with you, what you shared, and your secure links.</p>
          </div>
          <button type="button" onClick={() => void refresh()}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>
        <ErrorLine error={error} />
        {identity && (
          <div
            className="panel panel-pad"
            style={{ display: 'flex', alignItems: 'center', gap: 14 }}
          >
            <span className="tile" style={{ color: 'var(--secure)' }}>
              <Icon name="shieldCheck" size={18} />
            </span>
            <div className="row-main">
              <span className="row-title">Your security code</span>
              <span className="row-sub">
                Read it to people who share with you so they can check it is really you.
              </span>
            </div>
            <code className="secret" style={{ fontSize: 14 }}>
              {identity.fingerprint}
            </code>
          </div>
        )}

        <section>
          <div className="section-label">
            <span>Shared with you</span>
          </div>
          <ul className="panel rows">
            {incoming.map((s) => (
              <IncomingRow key={s.id} share={s} onRemove={act(() => api.removeUserShare(s.id))} />
            ))}
            {incoming.length === 0 && <li className="row muted">Nothing yet.</li>}
          </ul>
        </section>

        <section>
          <div className="section-label">
            <span>Shared by you</span>
          </div>
          <ul className="panel rows">
            {outgoing.map((s) => (
              <li key={s.id} className="row">
                <span className="avatar large">{s.recipient.email[0]?.toUpperCase()}</span>
                <div className="row-main">
                  <span className="row-title">{s.recipient.email}</span>
                  <span className="row-sub">Expires {when(s.expiresAt)}</span>
                </div>
                <button
                  type="button"
                  className="small danger"
                  onClick={act(() => api.removeUserShare(s.id))}
                >
                  Revoke
                </button>
              </li>
            ))}
            {outgoing.length === 0 && (
              <li className="row muted">Share an item from its page with the Share button.</li>
            )}
          </ul>
        </section>

        <section>
          <div className="section-label">
            <span>Secure links</span>
          </div>
          <ul className="panel rows">
            {links.map((l) => (
              <li key={l.id} className="row">
                <span className="tile">
                  <Icon name="link" size={15} />
                </span>
                <div className="row-main">
                  <span className="row-title">
                    {l.viewCount} of {l.maxViews} views
                  </span>
                  <span className="row-sub">Expires {when(l.expiresAt)}</span>
                </div>
                <span className={l.status === 'active' ? 'pill secure' : 'pill'}>{l.status}</span>
                {l.status === 'active' && (
                  <button
                    type="button"
                    className="small danger"
                    onClick={act(() => api.revokeLink(l.id))}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
            {links.length === 0 && <li className="row muted">No links yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function IncomingRow({ share, onRemove }: { share: IncomingUserShare; onRemove: () => void }) {
  const [item, setItem] = useState<SharedItemPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [pin, setPin] = useState<PinCheck>(() =>
    checkPin(share.sender.email, share.sender.publicKey),
  );

  useEffect(() => {
    sharingCore.fingerprint(share.sender.publicKey).then(setCode, () => setCode(null));
  }, [share.sender.publicKey]);

  async function open() {
    try {
      setItem(SharedItemPayload.parse(JSON.parse(await sharingCore.open(share))));
      // It decrypted under this key, so remember it for this sender.
      pinKey(share.sender.email, share.sender.publicKey);
      setPin('match');
    } catch {
      setError('Could not decrypt. It may have been sent to an older key of yours.');
    }
  }

  return (
    <li className="incoming">
      <div className="row">
        <span className="avatar large">{share.sender.email[0]?.toUpperCase()}</span>
        <div className="row-main">
          <span className="row-title">{item ? item.title : `From ${share.sender.email}`}</span>
          <span className="row-sub">
            {item && `From ${share.sender.email} · `}
            {new Date(share.createdAt).toLocaleString()}
            {code && (
              <>
                {' '}
                · security code <code>{code}</code>
              </>
            )}
          </span>
        </div>
        {!item && (
          <button type="button" className="small primary" onClick={() => void open()}>
            {pin === 'changed' ? 'Open anyway' : 'Open'}
          </button>
        )}
        <button type="button" className="small ghost" onClick={onRemove}>
          Remove
        </button>
      </div>
      {pin === 'changed' && !item && (
        <p role="alert" className="alert" style={{ margin: '0 16px 12px' }}>
          {share.sender.email}&apos;s security code has changed since you last received from them.
          Someone may be pretending to be them. Check the code with them before opening.
        </p>
      )}
      {error && (
        <p role="alert" className="alert" style={{ margin: '0 16px 12px' }}>
          {error}
        </p>
      )}
      {item && (
        <div className="rows incoming-fields">
          {item.username && (
            <div className="row">
              <div className="row-main">
                <span className="row-label">username</span>
                <span>{item.username}</span>
              </div>
              <CopyButton value={item.username} secret={false} />
            </div>
          )}
          {item.password && (
            <div className="row">
              <div className="row-main">
                <span className="row-label">password</span>
                <SecretText value={item.password} masked />
              </div>
              <CopyButton value={item.password} />
            </div>
          )}
          {item.url && (
            <div className="row">
              <div className="row-main">
                <span className="row-label">website</span>
                <span className="truncate">{item.url}</span>
              </div>
            </div>
          )}
          {item.notes && (
            <div className="row">
              <div className="row-main">
                <span className="row-label">notes</span>
                <p className="notes">{item.notes}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

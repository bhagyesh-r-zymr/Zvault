import {
  SharedItemPayload,
  type IncomingUserShare,
  type OutgoingUserShare,
  type ShareLinkSummary,
} from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SharingApi } from './api.js';
import { sharingCore, type SharingIdentity } from './core.js';

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
    <section className="sharing-center">
      <h2>Sharing</h2>
      {error && <p role="alert">{error}</p>}
      {identity && (
        <p className="hint">
          Your security code: <code>{identity.fingerprint}</code>
        </p>
      )}

      <h3>Shared with you</h3>
      {incoming.length === 0 && <p className="hint">Nothing yet.</p>}
      <ul>
        {incoming.map((s) => (
          <IncomingRow key={s.id} share={s} onRemove={act(() => api.removeUserShare(s.id))} />
        ))}
      </ul>

      <h3>Shared by you</h3>
      <ul>
        {outgoing.map((s) => (
          <li key={s.id}>
            {s.recipient.email} · expires {when(s.expiresAt)}{' '}
            <button onClick={act(() => api.removeUserShare(s.id))}>Revoke</button>
          </li>
        ))}
      </ul>

      <h3>Links</h3>
      <ul>
        {links.map((l) => (
          <li key={l.id}>
            {l.status} · {l.viewCount}/{l.maxViews} views · expires {when(l.expiresAt)}{' '}
            {l.status === 'active' && (
              <button onClick={act(() => api.revokeLink(l.id))}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IncomingRow({ share, onRemove }: { share: IncomingUserShare; onRemove: () => void }) {
  const [item, setItem] = useState<SharedItemPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    try {
      setItem(SharedItemPayload.parse(JSON.parse(await sharingCore.open(share))));
    } catch {
      setError('Could not decrypt. It may have been sent to an older key of yours.');
    }
  }

  return (
    <li>
      From {share.sender.email} · {new Date(share.createdAt).toLocaleString()}{' '}
      {!item && <button onClick={() => void open()}>Open</button>}
      <button onClick={onRemove}>Remove</button>
      {error && <p role="alert">{error}</p>}
      {item && (
        <dl>
          <dt>Title</dt>
          <dd>{item.title}</dd>
          {item.username && (
            <>
              <dt>Username</dt>
              <dd>{item.username}</dd>
            </>
          )}
          {item.password && (
            <>
              <dt>Password</dt>
              <dd>
                <button onClick={() => void navigator.clipboard.writeText(item.password ?? '')}>
                  Copy password
                </button>
              </dd>
            </>
          )}
          {item.url && (
            <>
              <dt>Website</dt>
              <dd>{item.url}</dd>
            </>
          )}
          {item.notes && (
            <>
              <dt>Notes</dt>
              <dd>
                <pre>{item.notes}</pre>
              </dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

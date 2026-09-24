import type { DeviceSession } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { DevicesApiError, type DevicesClient } from './client.js';
import { lastActive, platformLabel } from './format.js';

export interface DevicesPanelProps {
  client: DevicesClient;
  /** Called when the current session turns out to be gone, including when the user revokes it. */
  onSignedOut: () => void;
}

/** Settings screen listing where the account is signed in, with sign-out controls. */
export function DevicesPanel({ client, onSignedOut }: DevicesPanelProps) {
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DevicesApiError && e.signedOut) return onSignedOut();
      setError(e instanceof DevicesApiError ? e.message : 'Could not reach Zvault. Try again.');
    },
    [onSignedOut],
  );

  const refresh = useCallback(async () => {
    try {
      setDevices(await client.list());
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [client, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try {
      await action();
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  // Confirmation is inline: WKWebView does not reliably show window.confirm.
  function signOut(d: DeviceSession) {
    setConfirming(null);
    if (!d.current) return void run(d.id, () => client.revoke(d.id));
    setBusy(d.id);
    client.revoke(d.id).then(onSignedOut, (e: unknown) => {
      fail(e);
      setBusy(null);
    });
  }

  function signOutOthers() {
    setConfirming(null);
    void run('others', () => client.revokeOthers());
  }

  function confirmButtons(key: string, label: string, onConfirm: () => void) {
    if (confirming !== key) {
      return (
        <button type="button" disabled={busy !== null} onClick={() => setConfirming(key)}>
          {busy === key ? 'Signing out…' : label}
        </button>
      );
    }
    return (
      <span className="confirm">
        <button type="button" className="danger" onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" onClick={() => setConfirming(null)}>
          Cancel
        </button>
      </span>
    );
  }

  const others = devices?.filter((d) => !d.current).length ?? 0;

  return (
    <section className="devices" aria-labelledby="devices-heading">
      <header>
        <h2 id="devices-heading">Devices</h2>
        <p>Where your account is signed in. Sign out anything you don't recognise.</p>
      </header>

      {error && <p role="alert">{error}</p>}
      {devices === null && !error && <p aria-busy="true">Loading devices…</p>}

      {devices && (
        <ul>
          {devices.map((d) => (
            <li key={d.id} aria-current={d.current ? 'true' : undefined}>
              <div>
                <strong>{d.device.name}</strong>
                {d.current && <span className="badge">This device</span>}
                <div className="meta">
                  {platformLabel(d.device.platform)} · Zvault {d.device.appVersion} ·{' '}
                  {d.current ? 'Active now' : lastActive(d.lastSeenAt)} · Signed in{' '}
                  {new Date(d.createdAt).toLocaleDateString()}
                </div>
              </div>
              {confirmButtons(d.id, d.current ? 'Sign out here' : 'Sign out', () => signOut(d))}
            </li>
          ))}
        </ul>
      )}

      {others > 0 && (
        <p className="others">
          {confirmButtons(
            'others',
            `Sign out ${others} other ${others === 1 ? 'device' : 'devices'}`,
            signOutOthers,
          )}
        </p>
      )}
    </section>
  );
}

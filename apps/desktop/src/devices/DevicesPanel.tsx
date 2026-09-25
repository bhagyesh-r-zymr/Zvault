import type { DeviceSession } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { AddPhoneSheet } from './AddPhoneSheet.js';
import { DevicesApiError, type DevicesClient } from './client.js';
import type { PairingClient } from './pairing.js';
import { lastActive, platformLabel } from './format.js';
import { Icon } from '../ui/Icon.js';

export interface DevicesPanelProps {
  client: DevicesClient;
  /** Adds a phone by QR code. */
  pairing: PairingClient;
  /** API origin put in the QR code, so the phone talks to the same server. */
  apiUrl: string;
  /** Called when the current session turns out to be gone, including when the user revokes it. */
  onSignedOut: () => void;
}

/** Settings screen listing where the account is signed in, with sign-out controls. */
export function DevicesPanel({ client, pairing, apiUrl, onSignedOut }: DevicesPanelProps) {
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
        <button
          type="button"
          className="small"
          disabled={busy !== null}
          onClick={() => setConfirming(key)}
        >
          {busy === key ? 'Signing out…' : label}
        </button>
      );
    }
    return (
      <span className="actions">
        <button type="button" className="small danger" onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" className="small" onClick={() => setConfirming(null)}>
          Cancel
        </button>
      </span>
    );
  }

  const others = devices?.filter((d) => !d.current).length ?? 0;

  return (
    <section className="devices" aria-labelledby="devices-heading">
      <div className="section-label" style={{ marginBottom: 10 }}>
        <h2 id="devices-heading" style={{ color: 'var(--text)' }}>
          Signed-in devices
        </h2>
        <span className="actions">
          {others > 0 &&
            confirmButtons(
              'others',
              `Sign out ${others} other ${others === 1 ? 'device' : 'devices'}`,
              signOutOthers,
            )}
          <button type="button" className="small primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Add phone
          </button>
        </span>
      </div>
      <p className="secondary" style={{ marginBottom: 12 }}>
        Where your account is signed in. Sign out anything you don&apos;t recognise.
      </p>

      {error && (
        <p role="alert" className="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      {devices === null && !error && (
        <p aria-busy="true" className="muted">
          Loading devices…
        </p>
      )}

      {devices && (
        <ul className="panel rows">
          {devices.map((d) => (
            <li key={d.id} className="row" aria-current={d.current ? 'true' : undefined}>
              <Icon
                name={d.device.platform === 'macos' ? 'laptop' : 'device'}
                size={20}
                className="secondary"
                strokeWidth={1.8}
              />
              <div className="row-main">
                <span className="row-title">
                  {d.device.name}
                  {d.current && (
                    <span
                      style={{
                        color: 'var(--secure)',
                        fontSize: 12,
                        marginLeft: 8,
                        fontWeight: 400,
                      }}
                    >
                      This device
                    </span>
                  )}
                </span>
                <span className="row-sub">
                  {platformLabel(d.device.platform)} · Zvault {d.device.appVersion} ·{' '}
                  {d.current ? 'Active now' : lastActive(d.lastSeenAt)} · Signed in{' '}
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </div>
              {confirmButtons(d.id, d.current ? 'Sign out here' : 'Sign out', () => signOut(d))}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddPhoneSheet
          client={pairing}
          apiUrl={apiUrl}
          onClose={() => setAdding(false)}
          onAdded={() => void refresh()}
          onSignedOut={onSignedOut}
        />
      )}
    </section>
  );
}

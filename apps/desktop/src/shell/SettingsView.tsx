import { useMemo, useState } from 'react';
import { CliInstall, ClaudeSetup } from '../agents/CliSetup.js';
import '../agents/agents.css';
import type { Session } from '../auth.js';
import { maskedSecretKey, type RememberedAccount } from '../core.js';
import { createDevicesClient } from '../devices/client.js';
import { DevicesPanel } from '../devices/DevicesPanel.js';
import { createPairingClient } from '../devices/pairing.js';
import type { LockStatus } from '../lock.js';
import { LockSettingsPanel } from '../LockSettingsPanel.js';
import { API_URL } from '../sharing/api.js';
import { fetchTransport, twoFactorApi, TwoFactorSettings } from '../two-factor/index.js';
import { Icon } from '../ui/Icon.js';
import { UpdatePanel } from '../updates/UpdatePanel.js';

export type SettingsSection = 'security' | 'devices' | 'cli' | 'account';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'security', label: 'Security' },
  { id: 'devices', label: 'Devices' },
  { id: 'cli', label: 'Command line' },
  { id: 'account', label: 'Account' },
];

export function SettingsView(props: {
  session: Session;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  lockStatus: LockStatus | null;
  onLockChanged: () => void;
  remembered: RememberedAccount | null;
  onForgetSecretKey: () => Promise<void>;
  onSignOut: () => void;
}) {
  const { session } = props;
  const tfa = useMemo(
    () =>
      twoFactorApi(fetchTransport(API_URL, () => ({ Authorization: `Bearer ${session.token}` }))),
    [session.token],
  );
  const devices = useMemo(
    () => createDevicesClient({ baseUrl: API_URL, getToken: () => session.token }),
    [session.token],
  );
  const pairing = useMemo(
    () => createPairingClient({ baseUrl: API_URL, getToken: () => session.token }),
    [session.token],
  );

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Settings</h1>
          </div>
        </div>
        <div className="tabs-bar" role="tablist" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={props.section === s.id}
              onClick={() => props.onSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {props.section === 'security' && (
          <>
            <TwoFactorSettings api={tfa} account={session.email} />
            {props.lockStatus ? (
              <LockSettingsPanel status={props.lockStatus} onChanged={props.onLockChanged} />
            ) : (
              <p className="muted">Loading lock settings…</p>
            )}
          </>
        )}

        {props.section === 'devices' && (
          <DevicesPanel
            client={devices}
            pairing={pairing}
            apiUrl={API_URL}
            onSignedOut={props.onSignOut}
          />
        )}

        {props.section === 'cli' && (
          <>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Command-line tool</h2>
              <CliInstall />
            </section>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Connect Claude Code</h2>
              <ClaudeSetup />
            </section>
          </>
        )}

        {props.section === 'account' && (
          <>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Account</h2>
              <div className="panel rows">
                <div className="row">
                  <span className="avatar large">{session.email[0]?.toUpperCase()}</span>
                  <div className="row-main">
                    <span className="row-title">{session.email}</span>
                    <span className="row-sub">
                      Session ends {new Date(session.expiresAt).toLocaleString()}
                    </span>
                  </div>
                  <button type="button" onClick={props.onSignOut}>
                    <Icon name="logout" size={13} /> Sign out
                  </button>
                </div>
                <SavedSecretKeyRow
                  saved={props.remembered?.email === session.email ? props.remembered : null}
                  onForget={props.onForgetSecretKey}
                />
                <div className="row">
                  <Icon name="shield" size={18} className="secondary" />
                  <div className="row-main">
                    <span className="row-title">Zero-knowledge encryption</span>
                    <span className="row-sub">
                      Your master password and Secret Key never leave this Mac. Keep your Emergency
                      Kit somewhere safe: Zvault can&apos;t reset them for you.
                    </span>
                  </div>
                </div>
              </div>
            </section>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Updates</h2>
              <UpdatePanel />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** Whether this Mac remembers the Secret Key, with a way to make it forget. */
function SavedSecretKeyRow(props: {
  saved: RememberedAccount | null;
  onForget: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row">
      <Icon name="key" size={18} className="secondary" />
      <div className="row-main">
        <span className="row-title">Secret Key on this Mac</span>
        <span className="row-sub">
          {props.saved ? (
            <>
              <span className="mono">{maskedSecretKey(props.saved.secretKeyId)}</span> is saved in
              this Mac&apos;s Keychain, so signing in here asks only for your master password.
            </>
          ) : (
            'Not saved on this Mac. Zvault saves it the next time you sign in here.'
          )}
        </span>
        {error && <span className="row-sub error">{error}</span>}
      </div>
      {props.saved && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            props.onForget().then(
              () => setBusy(false),
              (e: unknown) => {
                setBusy(false);
                setError(String(e));
              },
            );
          }}
        >
          <Icon name="trash" size={13} /> Forget
        </button>
      )}
    </div>
  );
}

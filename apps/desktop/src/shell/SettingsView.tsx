import { useMemo } from 'react';
import { CliInstall, ClaudeSetup } from '../agents/CliSetup.js';
import '../agents/agents.css';
import type { Session } from '../auth.js';
import { createDevicesClient } from '../devices/client.js';
import { DevicesPanel } from '../devices/DevicesPanel.js';
import type { LockStatus } from '../lock.js';
import { LockSettingsPanel } from '../LockSettingsPanel.js';
import { API_URL } from '../sharing/api.js';
import { fetchTransport, twoFactorApi, TwoFactorSettings } from '../two-factor/index.js';
import { Icon } from '../ui/Icon.js';

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
          <DevicesPanel client={devices} onSignedOut={props.onSignOut} />
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
        )}
      </div>
    </div>
  );
}

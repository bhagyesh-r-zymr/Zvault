import { useCallback, useEffect, useState } from 'react';
import { CopyButton, ErrorLine, SwitchRow } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { SSH_AGENT_SOCKET } from '../vault/SshKey.js';
import { agents, sshAgent, type ActivityEntry, type SshAgentStatus } from './api.js';
import './agents.css';

const SSH_CONFIG = `Host *
  IdentityAgent ${SSH_AGENT_SOCKET}`;

const GIT_SIGNING = `git config --global gpg.format ssh
git config --global user.signingkey "<your SSH key's public key>"
git config --global commit.gpgsign true`;

function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Settings for the SSH agent: on or off, how to point ssh and git at it, and
 * the latest signatures it made.
 */
export function SshAgentPanel() {
  const [status, setStatus] = useState<SshAgentStatus | null>(null);
  const [recent, setRecent] = useState<ActivityEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    sshAgent.status().then(setStatus, (e: unknown) => setError(String(e)));
    sshAgent.activity().then(setRecent, () => setRecent([]));
  }, []);

  useEffect(() => {
    reload();
    const stop = agents.onActivity(reload);
    return () => void stop.then((unlisten) => unlisten());
  }, [reload]);

  const toggle = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    sshAgent
      .setEnabled(enabled)
      .then(setStatus, (e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const detail = !status
    ? 'Loading…'
    : status.error
      ? status.error
      : status.listening
        ? `Listening at ${status.socketPath ?? SSH_AGENT_SOCKET}`
        : 'Off. ssh and git can’t use the SSH keys in your vault.';

  return (
    <div className="cli-setup">
      <div className="panel rows">
        <SwitchRow
          title="Use Zvault as your SSH agent"
          detail={detail}
          checked={status?.enabled ?? false}
          disabled={!status || busy}
          onChange={toggle}
        />
        <div className="row">
          <Icon name="fingerprint" size={18} className="secondary" />
          <div className="row-main">
            <span className="row-title">Approve every use</span>
            <span className="row-sub">
              Each time ssh or git wants to sign with a key, Zvault asks first, with Touch ID when
              it&apos;s set up. Keys come from SSH key items in your vault and never leave this app.
            </span>
          </div>
        </div>
      </div>

      <div>
        <div className="section-label">
          <span>Point ssh at Zvault: add this to ~/.ssh/config</span>
        </div>
        <div className="cli-code">
          <pre>{SSH_CONFIG}</pre>
          <CopyButton value={SSH_CONFIG} secret={false} />
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          Or for one terminal: <code>export SSH_AUTH_SOCK={SSH_AGENT_SOCKET}</code>. Check it with{' '}
          <code>ssh-add -l</code>.
        </p>
      </div>

      <div>
        <div className="section-label">
          <span>Sign git commits with an SSH key</span>
        </div>
        <div className="cli-code">
          <pre>{GIT_SIGNING}</pre>
          <CopyButton value={GIT_SIGNING} secret={false} />
        </div>
      </div>

      {recent.length > 0 && (
        <div>
          <div className="section-label">
            <span>Recent use</span>
          </div>
          <div className="panel rows">
            {recent.map((a) => (
              <div key={`${a.at}-${a.peerPid ?? 0}-${a.outcome}`} className="row">
                <Icon
                  name={a.outcome === 'denied' ? 'close' : 'check'}
                  size={16}
                  className={a.outcome === 'denied' ? 'error' : 'cli-ok'}
                />
                <div className="row-main">
                  <span className="row-title">{a.purpose?.detail ?? 'Signed with an SSH key'}</span>
                  <span className="row-sub">
                    {a.agentName} · {when(a.at)}
                    {a.outcome === 'denied'
                      ? ' · denied'
                      : a.verifiedBy === 'touchId'
                        ? ' · Touch ID'
                        : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

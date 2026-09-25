import { useEffect, useState } from 'react';
import { CopyButton, ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { agents, type CliStatus } from './api.js';

/**
 * Installing the `zv` command-line tool and connecting Claude Code to it.
 * Shown in Settings and on the Agents screen.
 */

/** For builds that do not bundle `zv` (dev builds): the latest release's copy. */
const DOWNLOAD_COMMAND =
  'mkdir -p ~/.local/bin && curl -fsSL https://github.com/bhagyesh-r-zymr/Zvault/releases/latest/download/zv-macos-universal -o ~/.local/bin/zv && chmod +x ~/.local/bin/zv';

export const AGENT_NAME = 'Claude Code';

/**
 * What to paste into Claude Code (or ~/.claude/CLAUDE.md). Reads go through
 * the paired agent's scopes; `zv set` always acts as the user, so Zvault asks
 * for approval on every write.
 */
export const CLAUDE_GUIDE = `# Zvault secrets

My secrets live in Zvault, a password manager app on this Mac. Use its \`zv\` command to work with them. Never print secret values into this conversation, into files, or into logs.

- Paths look like \`zv://<project>/<environment>/[<folder>/]<KEY>\`, for example \`zv://web/staging/DATABASE_URL\`.
- First time only: run \`zv agent pair --name "${AGENT_NAME}"\` and wait while I approve it in Zvault (up to 2 minutes).
- See what exists (names only): \`zv ls --agent "${AGENT_NAME}" -r zv://<project>\`.
- Use secrets in a command without seeing them: \`zv run --agent "${AGENT_NAME}" --env NAME=zv://<project>/<environment>/<KEY> -- <command>\`, or \`--env-from zv://<project>/<environment>\` for a whole environment.
- Create or update a secret: \`printf '%s' '<value>' | zv set zv://<project>/<environment>/<KEY>\`. For a new random value, pipe a generator instead so the value never appears here: \`openssl rand -base64 32 | zv set zv://<project>/<environment>/<KEY>\`. Zvault asks me to approve every change, so tell me to check the app. The project and environment must already exist.
- If zv says Zvault is locked or a request was denied, ask me instead of retrying.
`;

/** Install button, terminal command, and where `zv` is linked. */
export function CliInstall() {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [pathLine, setPathLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agents.cliStatus().then(setStatus, () => setStatus(null));
  }, []);

  const install = async (admin: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const r = await agents.installCli(admin);
      setPathLine(r.onPath ? null : r.pathLine);
      setStatus(await agents.cliStatus());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'cancelled') setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const installed = status?.installedAt ?? null;
  const command = status?.command ?? DOWNLOAD_COMMAND;

  return (
    <div className="cli-setup">
      <div className="panel rows">
        <div className="row">
          <Icon
            name={installed ? 'check' : 'terminal'}
            size={18}
            className={installed ? 'cli-ok' : 'secondary'}
          />
          <div className="row-main">
            <span className="row-title">
              {installed ? 'zv is installed' : 'Install the zv command'}
            </span>
            <span className="row-sub">
              {installed ? (
                <span className="mono">{installed}</span>
              ) : status?.bundled === false ? (
                'This build does not include zv. Run the command below to download it.'
              ) : (
                'Lets you and your AI agents use Zvault secrets from a terminal.'
              )}
            </span>
          </div>
          {status?.bundled && (
            <button
              type="button"
              className={installed ? undefined : 'primary'}
              disabled={busy}
              onClick={() => void install(false)}
            >
              {installed ? 'Reinstall' : 'Install CLI'}
            </button>
          )}
        </div>
        {status?.bundled && installed && !status.onPath && (
          <div className="row">
            <div className="row-main">
              <span className="row-title">Not on your PATH yet</span>
              <span className="row-sub">
                New terminals won&apos;t find zv in this folder. Install it for all terminals
                instead (macOS asks for your password), or add{' '}
                <code>{pathLine ?? `export PATH="${dirname(installed)}:$PATH"`}</code> to your shell
                profile.
              </span>
            </div>
            <button type="button" disabled={busy} onClick={() => void install(true)}>
              Install for all
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="section-label">
          <span>Or run this in Terminal</span>
        </div>
        <div className="cli-code">
          <code>{command}</code>
          <CopyButton value={command} secret={false} />
        </div>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** Instructions to paste into Claude Code so it can pair and use `zv`. */
export function ClaudeSetup() {
  return (
    <div className="cli-setup">
      <ol className="hint cli-steps">
        <li>Install the zv command above.</li>
        <li>
          Copy these instructions and paste them into Claude Code. To make them stick, add them to{' '}
          <code>~/.claude/CLAUDE.md</code>.
        </li>
        <li>
          Claude runs <code>zv agent pair</code>. Confirm the code in Zvault and choose which
          secrets it may use.
        </li>
        <li>
          When Claude creates or changes a secret with <code>zv set</code>, Zvault asks you to
          approve it first.
        </li>
      </ol>
      <div className="cli-code tall">
        <pre>{CLAUDE_GUIDE}</pre>
        <CopyButton value={CLAUDE_GUIDE} secret={false} label="Copy instructions" />
      </div>
    </div>
  );
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

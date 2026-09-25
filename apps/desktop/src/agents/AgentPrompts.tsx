import { useEffect, useState } from 'react';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import {
  agents,
  APPROVAL_MODE_TEXT,
  type ApprovalMode,
  type ApprovalPrompt,
  type PairingPrompt,
  type PurposeKind,
} from './api.js';
import './agents.css';

type Prompt = { type: 'approval'; p: ApprovalPrompt } | { type: 'pairing'; p: PairingPrompt };

const WANTS: Record<PurposeKind, string> = {
  run: 'wants to run a command with',
  read: 'wants to read',
  export: 'wants to export',
  list: 'wants to list secret names',
  copy: 'wants to copy',
  set: 'wants to change',
  signIn: 'wants to sign in to zv',
  change: 'wants to make a change',
  readItem: 'wants to see a vault item',
  changeItem: 'wants to change your vault',
};

const MODES = Object.keys(APPROVAL_MODE_TEXT) as ApprovalMode[];

/**
 * Shows `zv` approval and pairing requests as they arrive, one at a time.
 * Mounted once by the app shell while Zvault is unlocked; Rust withdraws any
 * open prompt when Zvault locks.
 */
export function AgentPrompts() {
  const [queue, setQueue] = useState<Prompt[]>([]);

  useEffect(() => {
    const add = (prompt: Prompt) => setQueue((q) => [...q, prompt]);
    const stops = [
      agents.onApprovalRequest((p) => add({ type: 'approval', p })),
      agents.onPairingRequest((p) => add({ type: 'pairing', p })),
      agents.onPromptClosed((id) => setQueue((q) => q.filter((x) => x.p.requestId !== id))),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const done = () => setQueue((q) => q.filter((x) => x !== current));
  return current.type === 'approval' ? (
    <ApprovalSheet key={current.p.requestId} prompt={current.p} onDone={done} />
  ) : (
    <PairingSheet key={current.p.requestId} prompt={current.p} onDone={done} />
  );
}

function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

function ApprovalSheet({ prompt, onDone }: { prompt: ApprovalPrompt; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const who = prompt.principal === 'user' ? 'Your terminal' : prompt.agentName;
  const n = prompt.refs.length;
  const what = n === 0 ? '' : n === 1 ? ' 1 secret' : ` ${n} secrets`;

  const answer = async (approve: boolean) => {
    try {
      await agents.approve(prompt.requestId, approve);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet
      title={`${who} ${WANTS[prompt.purpose.kind]}${what}`}
      subtitle={
        prompt.principal === 'agent' ? (
          <span style={{ color: 'var(--secure)', display: 'inline-flex', gap: 6 }}>
            <Icon name="check" size={12} strokeWidth={2.4} /> Paired agent, key matches
          </span>
        ) : (
          'From zv in a terminal on this Mac'
        )
      }
      icon={
        <span className="tile agent-tile" style={{ width: 44, height: 44, borderRadius: 13 }}>
          {prompt.principal === 'user' ? <Icon name="terminal" size={18} /> : initials(who)}
        </span>
      }
      onClose={() => void answer(false)}
      width={480}
    >
      {prompt.purpose.detail && (
        <p className={prompt.purpose.destructive ? 'notice danger' : 'notice'}>
          <Icon name={prompt.purpose.destructive ? 'trash' : 'edit'} size={14} />
          {prompt.purpose.detail}
          {prompt.purpose.destructive && ' This cannot be undone.'}
        </p>
      )}
      <dl className="request-facts">
        {prompt.purpose.command.length > 0 && (
          <>
            <dt>Runs</dt>
            <dd>{prompt.purpose.command.join(' ')}</dd>
          </>
        )}
        {prompt.purpose.cwd && (
          <>
            <dt>Folder</dt>
            <dd>{prompt.purpose.cwd}</dd>
          </>
        )}
        <dt>Process</dt>
        <dd>{prompt.peerPid ? `pid ${prompt.peerPid} via zv` : 'zv'}</dd>
      </dl>
      {n > 0 && (
        <div className="panel rows">
          {prompt.refs.map((r) => (
            <div key={r} className="row">
              <span className="tile" style={{ width: 30, height: 30 }}>
                <Icon name="key" size={14} />
              </span>
              <span className="mono truncate" style={{ fontSize: 12 }}>
                {r}
              </span>
            </div>
          ))}
        </div>
      )}
      {prompt.purpose.kind === 'run' && (
        <p className="notice">
          <Icon name="shield" size={14} />
          Values go only into this command as environment variables and are masked in its output.
        </p>
      )}
      <ErrorLine error={error} />
      <div className="grid-2" style={{ gap: 8 }}>
        <button type="button" className="danger block" onClick={() => void answer(false)}>
          Deny
        </button>
        <button type="button" className="primary block" autoFocus onClick={() => void answer(true)}>
          {prompt.touchId && <Icon name="fingerprint" size={16} strokeWidth={1.8} />}
          {prompt.touchId ? 'Allow with Touch ID' : 'Allow'}
        </button>
      </div>
    </Sheet>
  );
}

/** Scope lines: `zv://project/env/*` places or exact paths. */
function parseScopes(text: string): { scopes: string[]; bad: string | null } {
  const scopes = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = scopes.find((s) => !/^zv:\/\/[a-z0-9-]+(\/[A-Za-z0-9_-]+){0,3}(\/\*)?$/.test(s));
  return { scopes, bad: bad ?? null };
}

function PairingSheet({ prompt, onDone }: { prompt: PairingPrompt; onDone: () => void }) {
  const [mode, setMode] = useState<ApprovalMode>('askEveryTime');
  const [scopeText, setScopeText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    const { scopes, bad } = parseScopes(scopeText);
    if (approve && bad) return setError(`${bad} is not a zv:// path or place like zv://web/dev/*.`);
    if (approve && scopes.length === 0) {
      return setError('Add at least one place or secret it may use, like zv://web/development/*.');
    }
    try {
      await agents.answerPairing(
        prompt.requestId,
        approve,
        approve ? { approval: mode, scopes } : undefined,
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet
      title={`Pair ${prompt.name}?`}
      subtitle="An AI tool on this Mac ran zv agent pair"
      icon={
        <span className="tile agent-tile" style={{ width: 44, height: 44, borderRadius: 13 }}>
          {initials(prompt.name)}
        </span>
      }
      onClose={() => void answer(false)}
      width={500}
    >
      <dl className="request-facts">
        <dt>Code</dt>
        <dd style={{ fontSize: 16, letterSpacing: 2 }}>{prompt.code}</dd>
        <dt>Process</dt>
        <dd>{prompt.peerPid ? `pid ${prompt.peerPid} via zv` : 'zv'}</dd>
      </dl>
      <p className="hint">Check that the terminal shows the same code before you pair.</p>
      <div className="field">
        <label htmlFor="pair-scopes">Secrets it can use</label>
        <textarea
          id="pair-scopes"
          rows={3}
          className="mono"
          value={scopeText}
          placeholder={'zv://web/development/*\nzv://payments-api/staging/STRIPE_KEY'}
          onChange={(e) => setScopeText(e.target.value)}
        />
        <span className="hint">One per line. A place ending in /* covers everything below it.</span>
      </div>
      <div>
        <div className="section-label">
          <span>When it asks for a secret</span>
        </div>
        <div className="choices" role="radiogroup" aria-label="Approval">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              className="choice"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
            >
              <strong>{APPROVAL_MODE_TEXT[m]}</strong>
            </button>
          ))}
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="grid-2" style={{ gap: 8 }}>
        <button type="button" className="danger block" onClick={() => void answer(false)}>
          Decline
        </button>
        <button type="button" className="primary block" onClick={() => void answer(true)}>
          Pair agent
        </button>
      </div>
    </Sheet>
  );
}

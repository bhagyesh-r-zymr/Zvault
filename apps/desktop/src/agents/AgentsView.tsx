import { useCallback, useEffect, useState } from 'react';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { agents, type ActivityEntry, type Agent, type ApprovalMode } from './api.js';
import { ClaudeSetup, CliInstall } from './CliSetup.js';
import './agents.css';

/**
 * Local AI agents that use secrets through the `zv` CLI. Pairing starts in
 * a terminal (`zv agent pair`) and is approved in the prompt the app shows;
 * this screen lists paired agents and changes what they may use.
 */

const POLICIES: { value: ApprovalMode; title: string; detail: string }[] = [
  { value: 'askEveryTime', title: 'Ask me each time', detail: 'Touch ID on every use' },
  { value: 'session15m', title: 'Allow for a session', detail: 'Ask again after 15 min' },
  { value: 'whileUnlocked', title: 'Allow while unlocked', detail: 'No prompt, still logged' },
];

const POLICY_SHORT: Record<ApprovalMode, string> = {
  askEveryTime: 'asks each time',
  session15m: '15 min sessions',
  whileUnlocked: 'while unlocked',
};

function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

function when(unix: number): string {
  const secs = Date.now() / 1000 - unix;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function describe(a: ActivityEntry): string {
  const what = a.refs.length === 1 ? a.refs[0]! : `${a.refs.length} secrets`;
  const cmd = a.purpose?.command.length ? ` for ${a.purpose.command.join(' ')}` : '';
  switch (a.outcome) {
    case 'paired':
      return 'Paired';
    case 'unpaired':
      return 'Unpaired';
    case 'denied':
      if (a.purpose?.detail)
        return `Denied: ${a.purpose.detail}${a.reason ? ` (${a.reason})` : ''}`;
      return `Denied${a.refs.length ? ` ${what}` : ''}${a.reason ? ` (${a.reason})` : ''}`;
    default:
      if (a.purpose?.detail) return a.purpose.detail;
      return a.refs.length ? `Used ${what}${cmd}` : `Allowed ${a.purpose?.kind ?? 'request'}`;
  }
}

export function AgentsView() {
  const [list, setList] = useState<Agent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newScope, setNewScope] = useState('');
  const [pairing, setPairing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const agent = list?.find((a) => a.id === selected) ?? list?.[0] ?? null;

  const reload = useCallback(async () => {
    try {
      setList(await agents.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const stop = agents.onActivity(() => void reload());
    return () => void stop.then((unlisten) => unlisten());
  }, [reload]);

  const agentId = agent?.id ?? null;
  useEffect(() => {
    if (!agentId) return setActivity([]);
    agents.activity(agentId, 20).then(setActivity, () => setActivity([]));
  }, [agentId, list]);

  const update = async (changes: Parameters<typeof agents.update>[1]) => {
    if (!agent) return;
    setError(null);
    try {
      await agents.update(agent.id, changes);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addScope = () => {
    const scope = newScope.trim();
    if (!agent || !scope) return;
    void update({ scopes: [...agent.scopes, scope] }).then(() => setNewScope(''));
  };

  return (
    <div className="split agents">
      <section className="list-pane" aria-label="Agents">
        <div className="list-head">
          <div className="title-row">
            <h2>Agents</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setInstalling(true)}>
                <Icon name="terminal" size={13} /> Install CLI
              </button>
              <button type="button" className="primary" onClick={() => setPairing(true)}>
                Pair an agent
              </button>
            </div>
          </div>
          <p className="hint" style={{ lineHeight: 1.5 }}>
            AI tools on this Mac that can use secrets through the <code>zv</code> command. They only
            get what you allow.
          </p>
        </div>
        <div className="list-body">
          {list?.map((a) => (
            <button
              key={a.id}
              type="button"
              className="list-item"
              aria-current={a.id === agent?.id}
              onClick={() => setSelected(a.id)}
            >
              <span className="tile agent-tile">{initials(a.name)}</span>
              <span className="row-main">
                <span className="row-title">{a.name}</span>
                <span className="row-sub">
                  {a.scopes.length} scope{a.scopes.length === 1 ? '' : 's'} ·{' '}
                  {a.paused ? 'paused' : POLICY_SHORT[a.approval]}
                </span>
              </span>
              <span className={`agent-status ${a.paused ? 'paused' : 'active'}`}>
                {a.paused ? 'Paused' : a.lastUsedAt ? when(a.lastUsedAt) : 'Idle'}
              </span>
            </button>
          ))}
          {list?.length === 0 && (
            <p className="hint" style={{ padding: 16 }}>
              No agents yet. Run <code>zv agent pair --name &quot;Claude Code&quot;</code> in a
              terminal to pair one.
            </p>
          )}
        </div>
      </section>

      <section className="detail-pane" aria-label={agent ? `${agent.name} details` : 'Agent'}>
        <div className="detail-body" style={{ paddingTop: 26 }}>
          <ErrorLine error={error} />
          {!agent ? (
            <>
              <h1>Connect an agent</h1>
              <CliInstall />
              <ClaudeSetup />
            </>
          ) : (
            <>
              <div className="item-head">
                <span className="tile large agent-tile">{initials(agent.name)}</span>
                <div style={{ flexGrow: 1 }}>
                  <h1>{agent.name}</h1>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {agent.id} · paired {when(agent.createdAt)}
                  </span>
                </div>
                <button type="button" onClick={() => void update({ paused: !agent.paused })}>
                  <Icon name={agent.paused ? 'arrowRight' : 'pause'} size={13} />
                  {agent.paused ? 'Resume' : 'Pause'}
                </button>
              </div>

              <div>
                <div className="section-label">
                  <span>When it asks for a secret</span>
                </div>
                <div className="choices" role="radiogroup" aria-label="Approval policy">
                  {POLICIES.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      role="radio"
                      className="choice"
                      aria-checked={agent.approval === p.value}
                      onClick={() => void update({ approval: p.value })}
                    >
                      <strong>{p.title}</strong>
                      <span>{p.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="section-label">
                  <span>Secrets it can use</span>
                </div>
                <div className="panel rows">
                  {agent.scopes.map((s) => (
                    <div key={s} className="row">
                      <div className="row-main">
                        <span className="mono truncate" style={{ fontSize: 12 }}>
                          {s}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="icon ghost small"
                        aria-label={`Remove ${s}`}
                        onClick={() => void update({ scopes: agent.scopes.filter((x) => x !== s) })}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ))}
                  {agent.scopes.length === 0 && (
                    <div className="row muted">
                      No secrets. This agent can&apos;t read anything.
                    </div>
                  )}
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      addScope();
                    }}
                  >
                    <input
                      className="mono"
                      style={{ flexGrow: 1 }}
                      value={newScope}
                      placeholder="zv://web/development/*"
                      aria-label="Add a scope"
                      onChange={(e) => setNewScope(e.target.value)}
                    />
                    <button type="submit" disabled={!newScope.trim()}>
                      Add
                    </button>
                  </form>
                </div>
              </div>

              <div>
                <div className="section-label">
                  <span>Recent activity</span>
                </div>
                <ul className="activity">
                  {activity.map((a, i) => (
                    <li key={`${a.at}-${i}`}>
                      <span
                        className="dot"
                        style={{
                          background:
                            a.outcome === 'denied' ? 'var(--danger-dot)' : 'var(--secure)',
                        }}
                      />
                      <span style={{ flexGrow: 1 }} className="truncate">
                        {describe(a)}
                      </span>
                      <span className="muted">{when(a.at)}</span>
                    </li>
                  ))}
                  {activity.length === 0 && <li className="muted">Nothing yet.</li>}
                </ul>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void agents
                      .unpair(agent.id)
                      .then(reload)
                      .catch((e: unknown) => setError(String(e)))
                  }
                >
                  Unpair {agent.name}
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {pairing && (
        <Sheet
          title="Pair an agent"
          subtitle="Pairing starts from the terminal the agent uses"
          onClose={() => setPairing(false)}
          width={520}
        >
          <div className="cli-setup">
            <CliInstall />
            <ol className="hint cli-steps">
              <li>
                In the agent&apos;s terminal, run{' '}
                <code>zv agent pair --name &quot;Claude Code&quot;</code>.
              </li>
              <li>Zvault asks you to confirm the code and choose what the agent may use.</li>
              <li>
                The agent then runs <code>zv run --env KEY=zv://project/env/KEY -- command</code>.
              </li>
            </ol>
          </div>
        </Sheet>
      )}
      {installing && (
        <Sheet
          title="Install the zv command"
          subtitle="Then paste the instructions into Claude Code"
          onClose={() => setInstalling(false)}
          width={560}
        >
          <div className="cli-setup">
            <CliInstall />
            <ClaudeSetup />
          </div>
        </Sheet>
      )}
    </div>
  );
}

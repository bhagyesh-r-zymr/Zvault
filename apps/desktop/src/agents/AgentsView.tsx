import { useState } from 'react';
import { PreviewNote } from '../projects/ProjectsView.js';
import { Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import './agents.css';

/**
 * Local AI agents that use secrets through the `zv` CLI. The CLI and the
 * app's approval bridge are being built separately; until they land this
 * screen runs on sample agents so the flow can be reviewed.
 */

type Policy = 'ask' | 'session' | 'unlocked';

interface Grant {
  name: string;
  where: string;
  ref: string;
}

interface Agent {
  id: string;
  name: string;
  initials: string;
  status: 'active' | 'idle' | 'paused';
  policy: Policy;
  key: string;
  paired: string;
  folder: string;
  grants: Grant[];
  activity: { ok: boolean; text: string; when: string }[];
}

const POLICIES: { value: Policy; title: string; detail: string }[] = [
  { value: 'ask', title: 'Ask me each time', detail: 'Touch ID on every use' },
  { value: 'session', title: 'Allow for a session', detail: 'Ask again after 15 min' },
  { value: 'unlocked', title: 'Allow while unlocked', detail: 'No prompt, still logged' },
];

const POLICY_SHORT: Record<Policy, string> = {
  ask: 'asks each time',
  session: '15 min sessions',
  unlocked: 'while unlocked',
};

const SAMPLE: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    initials: 'CC',
    status: 'active',
    policy: 'ask',
    key: '7F3A·C1E9·04B2',
    paired: 'Sep 20',
    folder: '~/code/zvault-api',
    grants: [
      {
        name: 'Stripe secret key',
        where: 'Payments API · Dev',
        ref: 'zv://payments-api/dev/stripe/secret_key',
      },
      { name: 'Postgres', where: 'Zvault · Staging', ref: 'zv://zvault/staging/postgres/password' },
      {
        name: 'GitHub deploy key',
        where: 'Zvault · Dev',
        ref: 'zv://zvault/dev/github-deploy/key',
      },
    ],
    activity: [
      { ok: true, text: 'Used Stripe secret key for npm test', when: '4 min ago' },
      { ok: false, text: 'Denied: asked for Zvault · Production (never allowed)', when: '1 h ago' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    initials: 'C',
    status: 'idle',
    policy: 'session',
    key: '19BE·77D0·A3C4',
    paired: 'Sep 18',
    folder: '~/code/customer-portal',
    grants: [
      {
        name: 'Auth0 client secret',
        where: 'Customer portal · Dev',
        ref: 'zv://customer-portal/dev/auth0/client_secret',
      },
    ],
    activity: [{ ok: true, text: 'Used Auth0 client secret for npm run dev', when: 'yesterday' }],
  },
  {
    id: 'deploy',
    name: 'deploy-script',
    initials: '>_',
    status: 'paused',
    policy: 'unlocked',
    key: 'C0DE·4411·9E2F',
    paired: 'Sep 2',
    folder: '~/code/zvault-infra',
    grants: [
      {
        name: 'AWS account',
        where: 'Zvault · Staging',
        ref: 'zv://zvault/staging/aws/secret_access_key',
      },
      {
        name: 'GitHub deploy key',
        where: 'Zvault · Staging',
        ref: 'zv://zvault/staging/github-deploy/key',
      },
    ],
    activity: [],
  },
];

export function AgentsView() {
  const [agents, setAgents] = useState(SAMPLE);
  const [selected, setSelected] = useState(SAMPLE[0]!.id);
  const [reviewing, setReviewing] = useState(false);
  const [requests, setRequests] = useState(1);
  const agent = agents.find((a) => a.id === selected) ?? agents[0]!;

  const update = (patch: Partial<Agent>) =>
    setAgents(agents.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)));

  return (
    <div className="split agents">
      <section className="list-pane" aria-label="Agents">
        <div className="list-head">
          <div className="title-row">
            <h2>Agents</h2>
            <button type="button" className="primary" disabled title="Arrives with the zv CLI">
              Pair an agent
            </button>
          </div>
          <p className="hint" style={{ lineHeight: 1.5 }}>
            AI tools on this Mac that can use secrets through the <code>zv</code> command. They only
            get what you allow.
          </p>
        </div>
        {requests > 0 && (
          <div className="request-banner">
            <span className="pulse" />
            <span>
              {requests} request{requests === 1 ? '' : 's'} waiting for you
            </span>
            <button type="button" className="link" onClick={() => setReviewing(true)}>
              Review
            </button>
          </div>
        )}
        <div className="list-body">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="list-item"
              aria-current={a.id === agent.id}
              onClick={() => setSelected(a.id)}
            >
              <span className="tile agent-tile">{a.initials}</span>
              <span className="row-main">
                <span className="row-title">{a.name}</span>
                <span className="row-sub">
                  {a.grants.length} secret{a.grants.length === 1 ? '' : 's'} ·{' '}
                  {a.status === 'paused' ? 'paused' : POLICY_SHORT[a.policy]}
                </span>
              </span>
              <span className={`agent-status ${a.status}`}>
                {a.status === 'active' ? 'Active' : a.status === 'idle' ? 'Idle' : 'Paused'}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="detail-pane" aria-label={`${agent.name} details`}>
        <div className="detail-body" style={{ paddingTop: 26 }}>
          <PreviewNote>Sample agents. Pairing and approvals go live with the zv CLI.</PreviewNote>
          <div className="item-head">
            <span className="tile large agent-tile">{agent.initials}</span>
            <div style={{ flexGrow: 1 }}>
              <h1>{agent.name}</h1>
              <span className="mono muted" style={{ fontSize: 12 }}>
                key {agent.key} · paired {agent.paired} · {agent.folder}
              </span>
            </div>
            <button
              type="button"
              onClick={() => update({ status: agent.status === 'paused' ? 'idle' : 'paused' })}
            >
              <Icon name={agent.status === 'paused' ? 'arrowRight' : 'pause'} size={13} />
              {agent.status === 'paused' ? 'Resume' : 'Pause'}
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
                  aria-checked={agent.policy === p.value}
                  onClick={() => update({ policy: p.value })}
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
              {agent.grants.map((g) => (
                <div key={g.ref} className="row">
                  <div className="row-main">
                    <span className="row-title">
                      {g.name} <span className="muted">· {g.where}</span>
                    </span>
                    <span className="mono muted truncate" style={{ fontSize: 12 }}>
                      {g.ref}
                    </span>
                  </div>
                  <span className="hint">as env var</span>
                  <button
                    type="button"
                    className="icon ghost small"
                    aria-label={`Remove ${g.name}`}
                    onClick={() => update({ grants: agent.grants.filter((x) => x.ref !== g.ref) })}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              {agent.grants.length === 0 && (
                <div className="row muted">No secrets. This agent can't read anything.</div>
              )}
            </div>
          </div>

          <div>
            <div className="section-label">
              <span>Recent activity</span>
            </div>
            <ul className="activity">
              {agent.activity.map((a) => (
                <li key={a.text}>
                  <span
                    className="dot"
                    style={{ background: a.ok ? 'var(--secure)' : 'var(--danger-dot)' }}
                  />
                  <span style={{ flexGrow: 1 }}>{a.text}</span>
                  <span className="muted">{a.when}</span>
                </li>
              ))}
              {agent.activity.length === 0 && <li className="muted">Nothing yet.</li>}
            </ul>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
            <button
              type="button"
              className="danger"
              onClick={() => {
                const rest = agents.filter((a) => a.id !== agent.id);
                setAgents(rest);
                if (rest[0]) setSelected(rest[0].id);
              }}
              disabled={agents.length === 1}
            >
              Unpair {agent.name}
            </button>
          </div>
        </div>
      </section>

      {reviewing && (
        <AgentRequestSheet
          onClose={() => setReviewing(false)}
          onDecided={() => {
            setReviewing(false);
            setRequests(0);
          }}
        />
      )}
    </div>
  );
}

/** The prompt shown when an agent runs `zv run` and needs approval. */
export function AgentRequestSheet({
  onClose,
  onDecided,
}: {
  onClose: () => void;
  onDecided: () => void;
}) {
  return (
    <Sheet
      title="Claude Code wants 2 secrets"
      subtitle={
        <span
          style={{ color: 'var(--secure)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Icon name="check" size={12} strokeWidth={2.4} /> Paired agent, key matches
        </span>
      }
      icon={
        <span className="tile agent-tile" style={{ width: 44, height: 44, borderRadius: 13 }}>
          CC
        </span>
      }
      onClose={onClose}
      width={480}
    >
      <dl className="request-facts">
        <dt>Runs</dt>
        <dd>npm test</dd>
        <dt>Folder</dt>
        <dd>~/code/zvault-api</dd>
        <dt>Process</dt>
        <dd>claude (pid 48213) via zv</dd>
      </dl>
      <div className="panel rows">
        <div className="row">
          <span className="tile" style={{ width: 30, height: 30 }}>
            <Icon name="key" size={14} />
          </span>
          <div className="row-main">
            <span className="row-title">
              Stripe secret key <span className="muted">· Payments API · Dev</span>
            </span>
            <span className="row-sub">
              secret_key → <code>STRIPE_SECRET_KEY</code>
            </span>
          </div>
          <span className="hint" style={{ color: 'var(--secure)' }}>
            Allowed
          </span>
        </div>
        <div className="row">
          <span className="tile" style={{ width: 30, height: 30 }}>
            <Icon name="database" size={14} />
          </span>
          <div className="row-main">
            <span className="row-title">
              Postgres <span className="muted">· Zvault · Staging</span>
            </span>
            <span className="row-sub">
              password → <code>DATABASE_PASSWORD</code>
            </span>
          </div>
          <span className="hint" style={{ color: 'var(--secure)' }}>
            Allowed
          </span>
        </div>
      </div>
      <p className="notice">
        <Icon name="shield" size={14} />
        Values go only into this command as environment variables and are masked in its output, so
        they never land in the agent&apos;s chat.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button type="button" className="primary large block" onClick={onDecided}>
          <Icon name="fingerprint" size={18} strokeWidth={1.8} />
          Allow once with Touch ID
        </button>
        <div className="grid-2" style={{ gap: 8 }}>
          <button type="button" className="block" onClick={onDecided}>
            Allow for 15 min
          </button>
          <button type="button" className="danger block" onClick={onDecided}>
            Deny
          </button>
        </div>
      </div>
    </Sheet>
  );
}

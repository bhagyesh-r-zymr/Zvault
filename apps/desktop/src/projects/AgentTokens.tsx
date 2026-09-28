import { TOKEN_LIFETIMES, type CreateTokenRequest, type TokenView } from '@zvault/shared';
import { createContext, useContext, useEffect, useId, useState, type FormEvent } from 'react';
import { ago } from '../trash/when.js';
import { CopyButton, ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { Environment, Project } from './model.js';
import { teamError } from './teamApi.js';
import { useAction } from './TeamPanels.js';
import { tokensCore, type TokensApi, type TokensCore } from './tokensApi.js';
import { expiresIn, tokenChain, usageSnippet } from './tokensModel.js';

/** The tokens API and the Rust core; provided by the app shell around the Access screen. */
export const TokensContext = createContext<{ api: TokensApi; core?: TokensCore } | null>(null);

const LIFETIME_LABELS: Record<(typeof TOKEN_LIFETIMES)[number], string> = {
  1: '1 day',
  7: '7 days',
  30: '30 days',
  90: '90 days',
  365: '1 year',
};

/**
 * Read-only tokens that let CI and cloud agents use one environment through
 * `zv` with `ZVAULT_TOKEN`, without this app. Each token is made here: this
 * device wraps the environment's key for it, and the server keeps only a
 * verifier and the wrapped keys.
 */
export function AgentTokens({
  project,
  keyVersions,
}: {
  project: Project;
  /** Current key version per environment id; environments not listed are at 1. */
  keyVersions: Record<string, number>;
}) {
  const ctx = useContext(TokensContext);
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const { busy, error, run } = useAction();

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let live = true;
    ctx.api.list(project.id).then(
      (list) => live && setTokens(list),
      (e: unknown) => live && setLoadError(teamError(e, 'Tokens could not be loaded.')),
    );
    return () => {
      live = false;
    };
  }, [ctx, project.id]);

  if (!ctx) return null;
  const envName = (id: string) => project.environments.find((e) => e.id === id)?.name ?? 'Deleted';
  const usable = project.environments.filter((e) => !e.locked);

  return (
    <div>
      <div className="section-label">
        <span>Tokens for CI and cloud agents</span>
        {tokens && tokens.length > 0 && <span className="pill">{tokens.length}</span>}
        <span style={{ flexGrow: 1 }} />
        <button
          type="button"
          className="small"
          disabled={usable.length === 0}
          title={usable.length === 0 ? 'You hold no environment keys in this project' : undefined}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={12} /> New token
        </button>
      </div>
      <ErrorLine error={error ?? loadError} />
      {tokens && tokens.length === 0 && (
        <div className="panel panel-pad token-empty">
          <Icon name="key" size={18} />
          <span className="secondary">
            A token lets a CI job or a cloud AI agent read one environment with <code>zv</code>,
            without this app. It is read-only, expires, and you can revoke it any time.
          </span>
        </div>
      )}
      {tokens && tokens.length > 0 && (
        <div className="panel rows">
          {tokens.map((t) => (
            <div key={t.id} className="row">
              <span className="avatar token-avatar">
                <Icon name="key" size={14} />
              </span>
              <div className="row-main">
                <span className="row-title">
                  {t.name}
                  {t.stale && (
                    <span
                      className="pill danger"
                      style={{ marginLeft: 8 }}
                      title="The environment key was rotated, so this token no longer works. Make a new one."
                    >
                      Re-issue needed
                    </span>
                  )}
                </span>
                <span className="row-sub">
                  Reads {envName(t.environmentIds[0]!)}
                  {t.environmentIds.length > 1 &&
                    ` (falls back to ${t.environmentIds.slice(1).map(envName).join(', ')})`}{' '}
                  · expires {expiresIn(t.expiresAt)} ·{' '}
                  {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'} · by{' '}
                  {t.createdBy.email}
                </span>
              </div>
              <button
                type="button"
                className="small danger"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    t.id,
                    async () => {
                      await ctx.api.revoke(project.id, t.id);
                      setTokens((list) => list?.filter((x) => x.id !== t.id) ?? null);
                    },
                    'The token could not be revoked.',
                  )
                }
              >
                {busy === t.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <NewTokenSheet
          project={project}
          environments={usable}
          keyVersions={keyVersions}
          core={ctx.core ?? tokensCore}
          api={ctx.api}
          onCreated={(t) => setTokens((list) => [...(list ?? []), t])}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewTokenSheet(props: {
  project: Project;
  environments: Environment[];
  keyVersions: Record<string, number>;
  core: TokensCore;
  api: TokensApi;
  onCreated: (token: TokenView) => void;
  onClose: () => void;
}) {
  const { project, environments } = props;
  const { busy, error, run } = useAction();
  const [name, setName] = useState('');
  const [envId, setEnvId] = useState(
    (environments.find((e) => e.kind === 'production') ?? environments[0])!.id,
  );
  const [days, setDays] = useState<number>(30);
  const [issued, setIssued] = useState<{ token: string; place: string } | null>(null);
  const nameId = useId();
  const daysId = useId();
  const chain = tokenChain(project.environments, envId);
  const env = environments.find((e) => e.id === envId)!;
  const fallbacks = chain.slice(1).map((id) => project.environments.find((e) => e.id === id)!.name);
  const place = `zv://${project.slug}/${env.slug}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await run(
      'create',
      async () => {
        const made = await props.core.issue(
          project.id,
          chain.map((id) => ({ environmentId: id, keyVersion: props.keyVersions[id] ?? 1 })),
        );
        const view = await props.api.create(project.id, {
          id: made.id,
          name: name.trim(),
          verifier: made.verifier as CreateTokenRequest['verifier'],
          expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
          encryptedProjectKey: made.encryptedProjectKey,
          environments: made.environments,
        });
        props.onCreated(view);
        setIssued({ token: made.token, place });
      },
      'The token could not be made.',
    );
  };

  if (issued) {
    return (
      <Sheet
        title="Copy your token"
        subtitle="Zvault can't show it again"
        icon={<Icon name="key" size={18} />}
        onClose={props.onClose}
        width={540}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="token-secret">
            <code>{issued.token}</code>
            <CopyButton value={issued.token} label="Copy token" />
          </div>
          <span className="secondary">
            Save it as a secret named <code>ZVAULT_TOKEN</code> in your CI or agent. With it,{' '}
            <code>zv</code> reads <code>{issued.place}</code> and nothing else:
          </span>
          <pre className="token-snippet">{usageSnippet(issued.place)}</pre>
          <p className="notice">
            <Icon name="shield" size={14} />
            The token is the key: the server only keeps a check value and keys locked to it, so it
            still can&apos;t read your secrets. Revoke it here if it leaks.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="primary" onClick={props.onClose}>
              Done
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="New token"
      subtitle="Read-only access for CI and cloud agents"
      icon={<Icon name="key" size={18} />}
      onClose={props.onClose}
      width={500}
    >
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="field">
          <label htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            value={name}
            maxLength={100}
            placeholder="GitHub Actions deploy"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <span>Environment</span>
          <div className="env-cards">
            {environments.map((e) => (
              <button
                key={e.id}
                type="button"
                className="choice"
                aria-pressed={e.id === envId}
                onClick={() => setEnvId(e.id)}
              >
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="dot" style={{ background: e.color }} />
                  {e.name}
                </strong>
              </button>
            ))}
          </div>
          <span className="hint">
            Reads <code>{place}</code>
            {fallbacks.length > 0 && `, falling back to ${fallbacks.join(', ')} like the app does`}.
          </span>
        </div>
        <div className="field">
          <label htmlFor={daysId}>Expires after</label>
          <select id={daysId} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {TOKEN_LIFETIMES.map((d) => (
              <option key={d} value={d}>
                {LIFETIME_LABELS[d]}
              </option>
            ))}
          </select>
        </div>
        <ErrorLine error={error} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy !== null || !name.trim()}>
            {busy === 'create' ? 'Making…' : 'Make token'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

import type { SyncTarget } from '@zvault/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { lastActive } from '../devices/format.js';
import { ErrorLine, Segmented, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { writeError } from './api.js';
import { useProjects, useProjectsSync, useSecretSync } from './context.js';
import type { Environment, Project } from './model.js';
import { EnvDot } from './ProjectsView.js';
import {
  describeTarget,
  itemsFor,
  PROVIDER_NAMES,
  type Provider,
  type TargetStatus,
} from './secretSync.js';

/** "Synced 5 minutes ago", "Synced just now". */
function when(iso: string): string {
  const text = lastActive(iso);
  return text === 'Active now' ? 'just now' : text;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function ProviderBadge({ provider }: { provider: Provider }) {
  return (
    <span className={`sync-badge ${provider}`} aria-hidden="true">
      {provider === 'github' ? 'GH' : 'AWS'}
    </span>
  );
}

function StatusLine({ status, auto }: { status: TargetStatus | undefined; auto: boolean }) {
  if (!status) {
    return (
      <span className="row-sub">{auto ? 'Waiting for the first sync' : 'Not synced yet'}</span>
    );
  }
  if (status.state === 'syncing') {
    return <span className="row-sub">Syncing…</span>;
  }
  const tone =
    status.state === 'synced' ? 'secure' : status.state === 'partial' ? 'attn' : 'danger';
  const label =
    status.state === 'synced' ? 'Synced' : status.state === 'partial' ? 'Partly synced' : 'Failed';
  return (
    <span className="row-sub sync-status">
      <span className={`pill ${tone}`}>{label}</span>
      {when(status.at)} · {status.message}
    </span>
  );
}

/** Where an environment's secrets sync to, with each target's last result. */
export function SyncSheet(props: {
  project: Project;
  env: Environment;
  canManage: boolean;
  onClose: () => void;
}) {
  const { project, canManage } = props;
  const view = useProjects();
  const sync = useProjectsSync();
  const { syncer, snapshot } = useSecretSync();
  const env = view.projects
    .find((p) => p.id === project.id)
    ?.environments.find((e) => e.id === props.env.id);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void syncer.connections().catch(() => undefined);
  }, [syncer]);

  if (!env) {
    return (
      <Sheet title="Sync" onClose={props.onClose} width={560}>
        <span className="secondary">This environment is no longer available.</span>
      </Sheet>
    );
  }

  const count = itemsFor(view, project, env).length;
  const connections = snapshot.connections;
  const providers = [...new Set(env.sync.map((t) => t.provider))];

  const save = async (targets: SyncTarget[]) => {
    setBusy(true);
    setError(null);
    try {
      await sync.setSyncTargets(project.id, env.id, targets);
      return true;
    } catch (e) {
      setError(writeError(e, 'The sync targets could not be saved.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Sync ${env.name}`}
      subtitle={
        <>
          <EnvDot env={env} /> {count === 1 ? '1 secret' : `${count} secrets`} in{' '}
          <span className="mono">
            zv://{project.slug}/{env.slug}
          </span>
        </>
      }
      onClose={props.onClose}
      width={600}
    >
      <div className="sync-sheet">
        <p className="secondary sync-lede">
          This Mac decrypts each value and sends it straight to GitHub or AWS. Zvault’s server never
          sees the values, and your GitHub and AWS keys stay in this Mac’s keychain.
        </p>

        {env.sync.length === 0 ? (
          <div className="panel panel-pad env-empty">
            <Icon name="refresh" size={26} />
            <strong>Not syncing anywhere yet</strong>
            <span className="secondary">
              Push these secrets to GitHub Actions or AWS Secrets Manager and keep them up to date
              when they change.
            </span>
          </div>
        ) : (
          <div className="panel rows">
            {env.sync.map((target) => {
              const status = snapshot.status[target.id];
              const auto = target.auto !== false;
              return (
                <div key={target.id} className="row sync-row">
                  <ProviderBadge provider={target.provider} />
                  <div className="row-main">
                    <span className="row-title">
                      {target.provider === 'github' ? 'GitHub Actions' : 'AWS Secrets Manager'}
                      <span className="mono secondary sync-where">{describeTarget(target)}</span>
                    </span>
                    <StatusLine status={status} auto={auto} />
                    {!auto && <span className="hint">Syncs only on Sync now</span>}
                  </div>
                  <button
                    type="button"
                    className="small"
                    disabled={status?.state === 'syncing' || env.locked}
                    onClick={() => void syncer.syncTarget(project.id, env.id, target.id)}
                  >
                    <Icon name="refresh" size={12} />
                    {status?.state === 'syncing' ? 'Syncing…' : 'Sync now'}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className="icon ghost"
                      aria-label={`Stop syncing to ${describeTarget(target)}`}
                      title="Stop syncing here"
                      disabled={busy}
                      onClick={() => void save(env.sync.filter((t) => t.id !== target.id))}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {env.sync.length > 0 && (
          <span className="hint">
            Syncs on its own when a value changes, while Zvault is unlocked on a Mac connected to
            the provider. Secrets removed here are removed from GitHub on the next sync. Stopping a
            sync leaves what was pushed in place.
          </span>
        )}

        {adding ? (
          <AddTarget
            existing={env.sync}
            busy={busy}
            onCancel={() => setAdding(false)}
            onAdd={async (t) => {
              if (await save([...env.sync, t])) setAdding(false);
            }}
          />
        ) : canManage ? (
          env.sync.length < 10 && (
            <button type="button" className="sync-add" onClick={() => setAdding(true)}>
              <Icon name="plus" size={13} strokeWidth={2.4} /> Add a place to sync to
            </button>
          )
        ) : (
          <span className="hint">
            Only the project owner or an admin can change where it syncs.
          </span>
        )}

        <Connections providers={adding ? ['github', 'aws'] : providers} connections={connections} />

        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Done
          </button>
          {env.sync.length > 0 && (
            <button
              type="button"
              className="primary"
              disabled={env.locked}
              onClick={() => void syncer.syncEnvironment(project.id, env.id).catch(() => undefined)}
            >
              <Icon name="refresh" size={13} /> Sync all now
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function AddTarget(props: {
  existing: SyncTarget[];
  busy: boolean;
  onCancel: () => void;
  onAdd: (target: SyncTarget) => void | Promise<void>;
}) {
  const [provider, setProvider] = useState<Provider>('github');
  const [repo, setRepo] = useState('');
  const [ghEnv, setGhEnv] = useState('');
  const [region, setRegion] = useState('ap-south-1');
  const [secretName, setSecretName] = useState('');
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ids = { repo: useId(), env: useId(), region: useId(), name: useId(), auto: useId() };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const common = { id: newId(), ...(auto ? {} : { auto: false }) };
    let target: SyncTarget;
    if (provider === 'github') {
      const r = repo
        .trim()
        .replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '');
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
        return setError('Name the repository as owner/name, for example acme/payments-api.');
      }
      target = {
        provider,
        repo: r,
        ...(ghEnv.trim() && { environment: ghEnv.trim() }),
        ...common,
      };
    } else {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(region.trim())) {
        return setError('Give an AWS region such as ap-south-1.');
      }
      if (!/^[A-Za-z0-9/_+=.@-]{1,512}$/.test(secretName.trim())) {
        return setError('The secret name may use letters, digits and /_+=.@-');
      }
      target = { provider, region: region.trim(), secretName: secretName.trim(), ...common };
    }
    const same = props.existing.some(
      (t) => JSON.stringify({ ...t, id: '' }) === JSON.stringify({ ...target, id: '' }),
    );
    if (same) return setError('This environment already syncs there.');
    void props.onAdd(target);
  };

  return (
    <form className="panel panel-pad sync-form" onSubmit={submit}>
      <Segmented
        label="Provider"
        options={[
          { value: 'github' as const, label: 'GitHub Actions' },
          { value: 'aws' as const, label: 'AWS Secrets Manager' },
        ]}
        value={provider}
        onChange={setProvider}
      />
      {provider === 'github' ? (
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.repo}>Repository</label>
            <input
              id={ids.repo}
              className="mono"
              value={repo}
              autoFocus
              placeholder="acme/payments-api"
              onChange={(e) => setRepo(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.env}>GitHub environment (optional)</label>
            <input
              id={ids.env}
              value={ghEnv}
              placeholder="Repository secrets"
              onChange={(e) => setGhEnv(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.name}>Secret name</label>
            <input
              id={ids.name}
              className="mono"
              value={secretName}
              autoFocus
              placeholder="payments-api/production"
              onChange={(e) => setSecretName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.region}>Region</label>
            <input
              id={ids.region}
              className="mono"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </div>
        </div>
      )}
      <span className="hint">
        {provider === 'github'
          ? 'Each secret becomes an Actions secret with the same name, sealed to the repository’s key before it leaves this Mac.'
          : 'The environment becomes one secret holding every variable as JSON. Zvault creates it on the first sync.'}
      </span>
      <label className="sync-check" htmlFor={ids.auto}>
        <input
          id={ids.auto}
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
        />
        Sync automatically when a value changes
      </label>
      <ErrorLine error={error} />
      <div className="sheet-actions">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={props.busy}>
          {props.busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}

/** This Mac's GitHub and AWS credentials. */
function Connections(props: {
  providers: Provider[];
  connections: Record<Provider, string | null> | null;
}) {
  if (props.providers.length === 0) return null;
  return (
    <div className="sync-connections">
      <span className="row-label">On this Mac</span>
      <div className="panel rows">
        {props.providers.map((p) => (
          <ConnectionRow key={p} provider={p} who={props.connections?.[p] ?? null} />
        ))}
      </div>
    </div>
  );
}

function ConnectionRow({ provider, who }: { provider: Provider; who: string | null }) {
  const { syncer, snapshot } = useSecretSync();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { token: useId(), keyId: useId(), secret: useId(), session: useId() };
  const loading = snapshot.connections === null;

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await syncer.connect(
        provider === 'github'
          ? { provider, token: token.trim() }
          : {
              provider,
              accessKeyId: keyId.trim(),
              secretAccessKey: secret.trim(),
              ...(session.trim() && { sessionToken: session.trim() }),
            },
      );
      setOpen(false);
    } catch (err) {
      setError(writeError(err, `${PROVIDER_NAMES[provider]} did not accept that.`));
    } finally {
      setToken('');
      setSecret('');
      setSession('');
      setBusy(false);
    }
  };

  return (
    <div className="sync-conn">
      <div className="row">
        <ProviderBadge provider={provider} />
        <div className="row-main">
          <span className="row-title">{PROVIDER_NAMES[provider]}</span>
          <span className="row-sub">
            {loading
              ? 'Checking the keychain…'
              : who
                ? `Connected as ${who}`
                : provider === 'github'
                  ? 'Not connected. Needs a fine-grained token with Secrets: read and write.'
                  : 'Not connected. Needs access keys allowed to put and create secrets.'}
          </span>
        </div>
        {who ? (
          <button
            type="button"
            className="small ghost"
            onClick={() => void syncer.disconnect(provider)}
          >
            Disconnect
          </button>
        ) : (
          !open &&
          !loading && (
            <button type="button" className="small primary" onClick={() => setOpen(true)}>
              Connect
            </button>
          )
        )}
      </div>
      {open && !who && (
        <form className="sync-form inset" onSubmit={(e) => void connect(e)}>
          {provider === 'github' ? (
            <div className="field">
              <label htmlFor={ids.token}>Personal access token</label>
              <input
                id={ids.token}
                type="password"
                className="mono"
                autoFocus
                autoComplete="off"
                value={token}
                placeholder="github_pat_…"
                onChange={(e) => setToken(e.target.value)}
              />
              <span className="hint">
                On GitHub: Settings › Developer settings › Fine-grained tokens. Pick the
                repositories, then Secrets (and Environments, for environment secrets): read and
                write.
              </span>
            </div>
          ) : (
            <>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={ids.keyId}>Access key ID</label>
                  <input
                    id={ids.keyId}
                    className="mono"
                    autoFocus
                    autoComplete="off"
                    value={keyId}
                    placeholder="AKIA…"
                    onChange={(e) => setKeyId(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={ids.secret}>Secret access key</label>
                  <input
                    id={ids.secret}
                    type="password"
                    className="mono"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor={ids.session}>Session token (optional)</label>
                <input
                  id={ids.session}
                  type="password"
                  className="mono"
                  autoComplete="off"
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                />
                <span className="hint">
                  Use an IAM user or role limited to secretsmanager:PutSecretValue and
                  secretsmanager:CreateSecret.
                </span>
              </div>
            </>
          )}
          <ErrorLine error={error} />
          <div className="sheet-actions">
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                busy || (provider === 'github' ? !token.trim() : !keyId.trim() || !secret.trim())
              }
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

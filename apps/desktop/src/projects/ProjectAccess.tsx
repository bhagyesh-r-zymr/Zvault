import type { AccessLevel } from '@zvault/shared';
import { useId, useState, type FormEvent } from 'react';
import { ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { useProjects, useProjectTeam, useTeam, useTeamStore } from './context.js';
import type { Project } from './model.js';
import { ProjectTile } from './ProjectsView.js';
import type { ProjectTeam } from './team.js';
import { MANAGERS_ONLY, teamError } from './teamApi.js';
import {
  LEVEL_LABELS,
  LEVEL_TEXT,
  buildMatrix,
  canManageEnv,
  candidates,
  isOrgAdmin,
  levelAttr,
  levelChoices,
  pendingHandOffs,
  rotationNeeded,
  type MatrixRow,
} from './teamModel.js';
import { AddAccessSheet, InviteSheet, OrgPanels, PrincipalAvatar } from './TeamPanels.js';

/** Who can use each environment of a project: groups, people and agents. */
export function ProjectAccess({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const team = useProjectTeam(projectId);
  const { store } = useTeamStore();
  const [inviting, setInviting] = useState(false);

  if (!project) {
    return (
      <div className="empty">
        <Icon name="people" size={32} />
        <span>This project is no longer available.</span>
      </div>
    );
  }
  const ready = team?.status === 'ready' ? team : null;

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-head">
          <ProjectTile project={project} size="large" />
          <div>
            <h1>{project.name} · Access</h1>
            <p>
              Decide who can see each environment. Folders and tags follow the environment they sit
              in.
            </p>
          </div>
          {ready?.org && (
            <button
              type="button"
              disabled={!isOrgAdmin(ready.org)}
              title={isOrgAdmin(ready.org) ? undefined : 'Only owners and admins can invite people'}
              onClick={() => setInviting(true)}
            >
              Invite people
            </button>
          )}
        </div>

        {(!team || team.status === 'loading') && (
          <div className="empty">
            <Icon name="people" size={32} />
            <span>Loading who has access…</span>
          </div>
        )}
        {team?.status === 'failed' && (
          <div
            className="panel panel-pad"
            style={{ display: 'flex', gap: 12, alignItems: 'center' }}
          >
            <span style={{ flexGrow: 1 }}>
              <ErrorLine error={team.error} />
            </span>
            <button type="button" onClick={() => void store.loadProject(project.id)}>
              <Icon name="refresh" size={13} /> Retry
            </button>
          </div>
        )}
        {team?.status === 'unshared' && <ShareWithOrg project={project} />}
        {ready && <AccessMatrix project={project} team={ready} />}
        {ready?.org && <OrgPanels projectId={project.id} org={ready.org} />}

        <p className="notice">
          <Icon name="shield" size={14} />
          Each environment is encrypted with its own key, so Production secrets are only ever sent
          to people and agents with Production access. Folders stay one level deep inside an
          environment.
        </p>
      </div>
      {inviting && ready?.org && (
        <InviteSheet projectId={project.id} org={ready.org} onClose={() => setInviting(false)} />
      )}
    </div>
  );
}

/** A project nobody else can reach yet: pick or create an organization to share it with. */
function ShareWithOrg({ project }: { project: Project }) {
  const { store } = useTeamStore();
  const { orgs, orgsStatus, orgsError } = useTeam();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const run = async (key: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(teamError(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the organization a name.');
    void run(
      'create',
      async () => {
        const org = await store.createOrg(name);
        setName('');
        await store.linkProject(project.id, org.id);
      },
      'The organization could not be created.',
    );
  };

  return (
    <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong>Only you can use {project.name}</strong>
        <span className="secondary">
          Share it with an organization to give teammates, groups and agents their own level in each
          environment. You stay its owner and a manager of every environment.
        </span>
      </div>
      {!project.owner && <span className="hint">Only the project&apos;s owner can share it.</span>}

      {orgsStatus === 'failed' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ flexGrow: 1 }}>
            <ErrorLine error={orgsError} />
          </span>
          <button type="button" className="small" onClick={() => void store.loadOrgs()}>
            Retry
          </button>
        </div>
      )}
      {orgsStatus === 'loading' && <span className="muted">Loading your organizations…</span>}
      {orgs.length > 0 && (
        <div className="panel rows">
          {orgs.map((o) => (
            <div key={o.id} className="row">
              <span className="avatar large">{o.name[0]}</span>
              <div className="row-main">
                <span className="row-title">{o.name}</span>
                <span className="row-sub">
                  {o.status === 'invited' ? 'You were invited' : `You are ${o.role}`}
                </span>
              </div>
              {o.status === 'invited' ? (
                <button
                  type="button"
                  className="small"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      o.id,
                      () => store.acceptInvite(o.id),
                      'The invite could not be accepted.',
                    )
                  }
                >
                  {busy === o.id ? 'Joining…' : 'Accept invite'}
                </button>
              ) : (
                <button
                  type="button"
                  className="small"
                  disabled={busy !== null || !project.owner}
                  onClick={() =>
                    void run(
                      o.id,
                      () => store.linkProject(project.id, o.id),
                      'The project could not be shared.',
                    )
                  }
                >
                  {busy === o.id ? 'Sharing…' : `Share with ${o.name}`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {orgsStatus === 'ready' && orgs.length === 0 && (
        <span className="muted">You aren&apos;t in an organization yet. Create one below.</span>
      )}

      {project.owner && (
        <form onSubmit={create} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field" style={{ flexGrow: 1 }}>
            <label htmlFor={nameId}>New organization</label>
            <input
              id={nameId}
              value={name}
              maxLength={64}
              placeholder="Acme engineering"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button type="submit" className="primary" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create and share'}
          </button>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

const NOT_SET = '';

function AccessMatrix({ project, team }: { project: Project; team: ProjectTeam }) {
  const { store, email } = useTeamStore();
  const access = team.access!;
  const org = team.org;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const envName = (id: string) =>
    project.environments.find((e) => e.id === id)?.name ?? 'Environment you can’t read';
  const envColor = (id: string) =>
    project.environments.find((e) => e.id === id)?.color ?? 'var(--muted)';
  const rows = buildMatrix({ access, envs: team.envs, org, meEmail: email });
  const handOffs = pendingHandOffs(access, team.envs, org, envName);
  const rotation = rotationNeeded(access);
  const managedEnvs = access.environments
    .map((e) => e.id)
    .filter((id) => canManageEnv(org, team.envs[id]));
  const addable = org ? candidates(org, rows) : [];

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(teamError(e, 'Access could not be changed.'));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const setLevel = (row: MatrixRow, envId: string, value: string) => {
    const cell = row.cells.find((c) => c.environmentId === envId);
    void run(`${row.key}:${envId}`, () =>
      value === NOT_SET
        ? store.revoke(project.id, row.principal, [envId])
        : store.grant(
            project.id,
            row.principal,
            value as AccessLevel,
            [envId],
            cell?.expiresAt ?? null,
          ),
    );
  };

  const removeRow = (row: MatrixRow) =>
    void run(row.key, () =>
      store.revoke(
        project.id,
        row.principal,
        row.cells.filter((c) => c.granted).map((c) => c.environmentId),
      ),
    );

  return (
    <>
      {rotation.length > 0 && (
        <div className="panel panel-pad" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="pill attn">Rotation needed</span>
          <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>
              {rotation.map(envName).join(', ')}: someone who held the key lost access. Rotate
              before adding new secrets there.
            </span>
            <span className="hint">
              Rotating re-seals every value under a new key on a manager&apos;s device. This version
              of Zvault can&apos;t do that yet, so the flag stays until an update adds it.
            </span>
          </span>
          <button type="button" disabled title="Needs key rotation in the desktop core">
            Rotate key
          </button>
        </div>
      )}

      {handOffs.length > 0 && (
        <div
          className="panel panel-pad"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <strong style={{ fontSize: 13 }}>Waiting for their key</strong>
          <span className="hint">
            They have access on the server, but a manager&apos;s device has to wrap the key to them
            before they can read anything. This version of Zvault can&apos;t wrap keys to teammates
            yet, so until an update adds it they see these as locked.
          </span>
          <div className="tags">
            {handOffs.map((h) => (
              <span key={h.accountId} className="pill">
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{h.name}</span>
                {h.waitingFor.join(', ')}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="legend">
        {LEVEL_TEXT.map((l) => (
          <div key={l.level} className="panel">
            <span
              className="level"
              data-level={levelAttr(l.level)}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              {LEVEL_LABELS[l.level]}
            </span>
            {l.text}
          </div>
        ))}
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="access-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              {access.environments.map((env) => (
                <th key={env.id} scope="col">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="dot" style={{ background: envColor(env.id) }} />
                    {envName(env.id)}
                  </span>
                </th>
              ))}
              <th scope="col" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <span className="who">
                    <PrincipalAvatar type={row.principal.type} name={row.name} />
                    <span>
                      <span className="row-title">
                        {row.name}
                        {row.you && <span className="muted"> · you</span>}
                      </span>
                      <span className="row-sub">{row.detail}</span>
                    </span>
                  </span>
                </th>
                {row.cells.map((cell) => {
                  const value = cell.granted ? cell.level : NOT_SET;
                  const choices = levelChoices(row.principal.type);
                  const allowed = canManageEnv(org, team.envs[cell.environmentId]);
                  return (
                    <td key={cell.environmentId}>
                      <select
                        className="level"
                        data-level={cell.granted ? levelAttr(cell.level) : 'none'}
                        aria-label={`${row.name} in ${envName(cell.environmentId)}`}
                        value={value}
                        disabled={!allowed || busy !== null}
                        title={allowed ? undefined : MANAGERS_ONLY}
                        onChange={(e) => setLevel(row, cell.environmentId, e.target.value)}
                      >
                        <option value={NOT_SET}>Not set</option>
                        {(value === NOT_SET || choices.includes(value)
                          ? choices
                          : [...choices, value]
                        ).map((l) => (
                          <option key={l} value={l}>
                            {row.principal.type === 'agent' && l === 'none'
                              ? 'Never'
                              : LEVEL_LABELS[l]}
                          </option>
                        ))}
                      </select>
                      {cell.expiresAt && cell.granted && (
                        <span className="row-sub" style={{ marginTop: 4 }}>
                          ends {new Date(cell.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {confirming === row.key ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span className="secondary">Remove everywhere?</span>
                      <button type="button" className="small" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="small danger"
                        disabled={busy !== null}
                        onClick={() => removeRow(row)}
                      >
                        {busy === row.key ? 'Removing…' : 'Remove'}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon ghost small"
                      aria-label={`Remove ${row.name} from ${project.name}`}
                      disabled={busy !== null || row.cells.every((c) => !c.granted)}
                      onClick={() => setConfirming(row.key)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={access.environments.length + 2} className="muted">
                  Nobody has access to any environment yet. Add a group, a person or an agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ErrorLine error={error} />
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          disabled={addable.length === 0 || managedEnvs.length === 0 || busy !== null}
          title={
            managedEnvs.length === 0
              ? MANAGERS_ONLY
              : addable.length === 0
                ? 'Everyone in the organization is already listed'
                : undefined
          }
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={13} strokeWidth={2.4} />
          Add people, groups or agents
        </button>
        {managedEnvs.length === 0 && <span className="hint">{MANAGERS_ONLY}</span>}
      </div>

      {adding && (
        <AddAccessSheet
          projectId={project.id}
          candidates={addable}
          environments={managedEnvs.map((id) => ({
            id,
            name: envName(id),
            color: envColor(id),
          }))}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

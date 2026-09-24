import type { AccessLevel, OrgDetail, OrgRole, PrincipalType } from '@zvault/shared';
import { useId, useState, type FormEvent } from 'react';
import { ErrorLine, Segmented, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { useTeamStore } from './context.js';
import { MANAGERS_ONLY, teamError } from './teamApi.js';
import {
  LEVEL_LABELS,
  ROLE_LABELS,
  isOrgAdmin,
  levelChoices,
  principalKey,
  type Candidate,
} from './teamModel.js';

export function PrincipalAvatar({ type, name }: { type: PrincipalType; name: string }) {
  return (
    <span
      className="avatar large"
      style={
        type === 'agent'
          ? { background: 'var(--attn-bg)', color: 'var(--attn)' }
          : type === 'account'
            ? { borderRadius: '50%', background: '#33203a', color: '#d9a3f5' }
            : undefined
      }
    >
      {type === 'agent' ? <Icon name="agent" size={15} /> : (name[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** Runs one change at a time and keeps its error, for the panels below. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(teamError(e, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

/** The organization a project is shared with: its members, groups and agents. */
export function OrgPanels({ projectId, org }: { projectId: string; org: OrgDetail }) {
  const { store, email } = useTeamStore();
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const admin = isOrgAdmin(org);
  const me = org.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  const emailOf = (id: string) => org.members.find((m) => m.accountId === id)?.email ?? 'Removed';

  const confirmRow = (key: string, question: string, label: string, action: () => void) =>
    confirming === key ? (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="secondary">{question}</span>
        <button type="button" className="small" onClick={() => setConfirming(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="small danger"
          disabled={busy !== null}
          onClick={() => {
            setConfirming(null);
            action();
          }}
        >
          {label}
        </button>
      </span>
    ) : (
      <button
        type="button"
        className="icon ghost small"
        aria-label={label}
        disabled={busy !== null}
        onClick={() => setConfirming(key)}
      >
        <Icon name="trash" size={13} />
      </button>
    );

  const createGroup = (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    void run(
      'group',
      async () => {
        await store.createGroup(projectId, org.id, groupName);
        setGroupName('');
      },
      'The group could not be created.',
    );
  };

  return (
    <>
      <div className="section-label">
        <span>Organization · {org.name}</span>
        <span className="pill">You are {ROLE_LABELS[org.role].toLowerCase()}</span>
      </div>
      {!admin && <span className="hint">{MANAGERS_ONLY} Owners and admins manage the team.</span>}
      <ErrorLine error={error} />

      <div>
        <div className="section-label">
          <span>Members</span>
        </div>
        <div className="panel rows">
          {org.members.map((m) => {
            const you = m.accountId === me?.accountId;
            return (
              <div key={m.accountId} className="row">
                <PrincipalAvatar type="account" name={m.email} />
                <div className="row-main">
                  <span className="row-title">
                    {m.email}
                    {you && <span className="muted"> · you</span>}
                  </span>
                  <span className="row-sub">
                    {m.status === 'invited' ? 'Invited, hasn’t joined yet' : ROLE_LABELS[m.role]}
                    {m.groupIds.length > 0 &&
                      ` · ${m.groupIds
                        .map((id) => org.groups.find((g) => g.id === id)?.name)
                        .filter(Boolean)
                        .join(', ')}`}
                  </span>
                </div>
                {admin && !you ? (
                  <>
                    <select
                      className="level"
                      aria-label={`Role of ${m.email}`}
                      value={m.role}
                      disabled={busy !== null}
                      onChange={(e) =>
                        void run(
                          `role:${m.accountId}`,
                          () =>
                            store.changeRole(
                              projectId,
                              org.id,
                              m.accountId,
                              e.target.value as OrgRole,
                            ),
                          'The role could not be changed.',
                        )
                      }
                    >
                      {(['owner', 'admin', 'member'] as const).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    {confirmRow(
                      `member:${m.accountId}`,
                      `Remove from ${org.name}?`,
                      `Remove ${m.email}`,
                      () =>
                        void run(
                          `member:${m.accountId}`,
                          () => store.removeMember(projectId, org.id, m.accountId),
                          'The member could not be removed.',
                        ),
                    )}
                  </>
                ) : (
                  <span className="hint">{ROLE_LABELS[m.role]}</span>
                )}
              </div>
            );
          })}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Removing someone takes away every grant they had and flags the environments they could
          read for a key rotation.
        </p>
      </div>

      <div>
        <div className="section-label">
          <span>Groups</span>
        </div>
        <div className="panel rows">
          {org.groups.map((g) => {
            const outside = org.members.filter(
              (m) => m.status === 'active' && !g.memberIds.includes(m.accountId),
            );
            return (
              <div key={g.id} className="row" style={{ alignItems: 'flex-start' }}>
                <PrincipalAvatar type="group" name={g.name} />
                <div className="row-main" style={{ gap: 8 }}>
                  <span className="row-title">
                    {g.name}{' '}
                    <span className="muted">
                      · {g.memberIds.length} teammate{g.memberIds.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <div className="tags">
                    {g.memberIds.map((id) => (
                      <span key={id} className="chip">
                        {emailOf(id)}
                        {admin && (
                          <button
                            type="button"
                            aria-label={`Remove ${emailOf(id)} from ${g.name}`}
                            disabled={busy !== null}
                            onClick={() =>
                              void run(
                                `gm:${g.id}:${id}`,
                                () => store.removeFromGroup(projectId, org.id, g.id, id),
                                'They could not be removed from the group.',
                              )
                            }
                          >
                            <Icon name="close" size={10} />
                          </button>
                        )}
                      </span>
                    ))}
                    {g.memberIds.length === 0 && <span className="muted">No one yet.</span>}
                    {admin && outside.length > 0 && (
                      <select
                        className="level"
                        aria-label={`Add someone to ${g.name}`}
                        value=""
                        disabled={busy !== null}
                        onChange={(e) =>
                          void run(
                            `ga:${g.id}`,
                            () => store.addToGroup(projectId, org.id, g.id, e.target.value),
                            'They could not be added to the group.',
                          )
                        }
                      >
                        <option value="">Add member…</option>
                        {outside.map((m) => (
                          <option key={m.accountId} value={m.accountId}>
                            {m.email}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                {admin &&
                  confirmRow(
                    `group:${g.id}`,
                    `Delete ${g.name}?`,
                    `Delete ${g.name}`,
                    () =>
                      void run(
                        `group:${g.id}`,
                        () => store.deleteGroup(projectId, org.id, g.id),
                        'The group could not be deleted.',
                      ),
                  )}
              </div>
            );
          })}
          {org.groups.length === 0 && (
            <div className="row muted">
              No groups yet. A group gives several teammates the same access in one step.
            </div>
          )}
        </div>
        {admin && (
          <form
            onSubmit={createGroup}
            style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}
          >
            <input
              aria-label="New group name"
              placeholder="New group, e.g. Backend team"
              value={groupName}
              maxLength={64}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <button type="submit" disabled={busy !== null || !groupName.trim()}>
              {busy === 'group' ? 'Creating…' : 'Create group'}
            </button>
          </form>
        )}
      </div>

      <div>
        <div className="section-label">
          <span>Agents</span>
        </div>
        <div className="panel rows">
          {org.agents.map((a) => (
            <div key={a.id} className="row">
              <PrincipalAvatar type="agent" name={a.name} />
              <div className="row-main">
                <span className="row-title">{a.name}</span>
                <span className="row-sub">Paired by {emailOf(a.ownerId)} · asks each time</span>
              </div>
              {(admin || a.ownerId === me?.accountId) &&
                confirmRow(
                  `agent:${a.id}`,
                  `Remove ${a.name}?`,
                  `Remove ${a.name}`,
                  () =>
                    void run(
                      `agent:${a.id}`,
                      () => store.removeAgent(projectId, org.id, a.id),
                      'The agent could not be removed.',
                    ),
                )}
            </div>
          ))}
          {org.agents.length === 0 && (
            <div className="row muted">
              No agents are registered with this organization. Agents paired with zv on this Mac are
              managed under Agents; registering one with a team needs an agent key the zv CLI
              doesn&apos;t create yet.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Invites an existing Zvault account to the organization. */
export function InviteSheet(props: { projectId: string; org: OrgDetail; onClose: () => void }) {
  const { store } = useTeamStore();
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [sent, setSent] = useState<string | null>(null);
  const emailId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (!to) return;
    const ok = await run(
      'invite',
      () => store.invite(props.projectId, props.org.id, { email: to, role }),
      'The invite could not be sent.',
    );
    if (ok) {
      setSent(to);
      setEmail('');
    }
  };

  return (
    <Sheet
      title={`Invite to ${props.org.name}`}
      subtitle="They need a Zvault account already"
      onClose={props.onClose}
      width={460}
    >
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            type="email"
            value={email}
            autoFocus
            maxLength={254}
            placeholder="riya@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <span>Role</span>
          <Segmented
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: 'member', label: 'Member' },
              { value: 'admin', label: 'Admin' },
            ]}
          />
          <span className="hint">
            Admins manage members, groups and every environment&apos;s access. Only owners can
            invite admins.
          </span>
        </div>
        {sent && (
          <p className="notice">
            <Icon name="check" size={14} />
            Invited {sent}. They join from Access in their Zvault app, which publishes their key.
            Then give them access to the environments they need.
          </p>
        )}
        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Done
          </button>
          <button type="submit" className="primary" disabled={busy !== null || !email.trim()}>
            {busy ? 'Inviting…' : 'Send invite'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Gives a group, person or agent a level in chosen environments. */
export function AddAccessSheet(props: {
  projectId: string;
  candidates: Candidate[];
  environments: { id: string; name: string; color: string }[];
  onClose: () => void;
}) {
  const { store } = useTeamStore();
  const { busy, error, run } = useAction();
  const [who, setWho] = useState(principalKey(props.candidates[0]!.principal));
  const candidate = props.candidates.find((c) => principalKey(c.principal) === who)!;
  const choices = levelChoices(candidate.principal.type);
  const [picked, setPicked] = useState<AccessLevel>('use');
  const level = choices.includes(picked) ? picked : choices[0]!;
  const [envIds, setEnvIds] = useState<string[]>(props.environments.map((e) => e.id));
  const [ends, setEnds] = useState('');
  const whoId = useId();
  const levelId = useId();
  const endsId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (envIds.length === 0) return;
    const expiresAt =
      candidate.principal.type === 'account' && ends
        ? new Date(`${ends}T23:59:59`).toISOString()
        : null;
    const ok = await run(
      'add',
      () => store.grant(props.projectId, candidate.principal, level, envIds, expiresAt),
      'Access could not be given.',
    );
    if (ok) props.onClose();
  };

  const group = (type: PrincipalType, label: string) => {
    const list = props.candidates.filter((c) => c.principal.type === type);
    return (
      list.length > 0 && (
        <optgroup label={label}>
          {list.map((c) => (
            <option key={principalKey(c.principal)} value={principalKey(c.principal)}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )
    );
  };

  return (
    <Sheet
      title="Add access"
      subtitle="Choose who, and what they can do"
      onClose={props.onClose}
      width={500}
    >
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="field">
          <label htmlFor={whoId}>Who</label>
          <select id={whoId} value={who} onChange={(e) => setWho(e.target.value)}>
            {group('group', 'Groups')}
            {group('account', 'People')}
            {group('agent', 'Agents')}
          </select>
        </div>
        <div className="field">
          <label htmlFor={levelId}>Level</label>
          <select
            id={levelId}
            value={level}
            onChange={(e) => setPicked(e.target.value as AccessLevel)}
          >
            {choices.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
          {candidate.principal.type === 'agent' && (
            <span className="hint">Agents always ask each time: a manager approves every use.</span>
          )}
        </div>
        <div className="field">
          <span>Environments</span>
          <div className="env-cards">
            {props.environments.map((env) => (
              <button
                key={env.id}
                type="button"
                className="choice"
                aria-pressed={envIds.includes(env.id)}
                onClick={() =>
                  setEnvIds(
                    envIds.includes(env.id)
                      ? envIds.filter((x) => x !== env.id)
                      : [...envIds, env.id],
                  )
                }
              >
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="dot" style={{ background: env.color }} />
                  {env.name}
                </strong>
              </button>
            ))}
          </div>
          <span className="hint">Only environments you manage are listed.</span>
        </div>
        {candidate.principal.type === 'account' && (
          <div className="field">
            <label htmlFor={endsId}>Access ends (optional)</label>
            <input
              id={endsId}
              type="date"
              value={ends}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setEnds(e.target.value)}
            />
            <span className="hint">
              For contractors: their grant lapses at the end of that day.
            </span>
          </div>
        )}
        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy !== null || envIds.length === 0}>
            {busy ? 'Saving…' : 'Give access'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

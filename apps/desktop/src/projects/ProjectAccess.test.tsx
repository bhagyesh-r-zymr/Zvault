/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, KEY, access, envAccess, org, project, request } from '../test/projectsFixtures.js';
import { fakeSync, fakeTeam, renderWithProjects } from '../test/projectsHarness.js';
import { mockCore } from '../test/tauri.js';
import { ProjectAccess } from './ProjectAccess.js';
import type { KeyHandOver, ProjectTeam, TeamSnapshot } from './team.js';
import { TeamError } from './teamApi.js';

const ready = (over: Partial<ProjectTeam> = {}): ProjectTeam => ({
  status: 'ready',
  error: null,
  access: access(),
  org: org(),
  envs: {
    [IDS.dev]: envAccess(IDS.dev),
    [IDS.prod]: envAccess(IDS.prod, { keyVersion: 2, rotationRequired: true }),
  },
  requests: {},
  ...over,
});

function setup(
  team: ProjectTeam | undefined,
  opts: {
    snapshot?: Partial<TeamSnapshot>;
    methods?: Record<string, unknown>;
    sync?: ReturnType<typeof fakeSync>;
    email?: string;
  } = {},
) {
  const store = fakeTeam({ [IDS.project]: team }, opts.snapshot, opts.methods);
  const out = renderWithProjects(<ProjectAccess projectId={IDS.project} />, {
    team: store,
    ...(opts.sync && { sync: opts.sync }),
    ...(opts.email && { email: opts.email }),
  });
  return { store, ...out };
}

beforeEach(() => {
  mockCore({ copy_secret: 30 });
});

describe('ProjectAccess states', () => {
  it('says when the project is gone', () => {
    const store = fakeTeam();
    renderWithProjects(<ProjectAccess projectId="nope" />, { team: store });
    expect(screen.getByText('This project is no longer available.')).toBeInTheDocument();
  });

  it('shows loading, then a failure with retry', async () => {
    const user = userEvent.setup();
    const a = setup(undefined);
    expect(screen.getByText('Loading who has access…')).toBeInTheDocument();
    expect(a.store.loadProject).toHaveBeenCalledWith(IDS.project);
    a.unmount();
    const b = setup({
      ...ready(),
      status: 'failed',
      error: 'Access went wrong',
      access: null,
      org: null,
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Access went wrong');
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(b.store.loadProject).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectAccess unshared', () => {
  const unshared = (): ProjectTeam => ({ ...ready(), status: 'unshared', access: null, org: null });
  const orgs = [
    { id: IDS.org, name: 'Acme', role: 'owner' as const, status: 'active' as const },
    { id: 'o2', name: 'Beta', role: 'member' as const, status: 'invited' as const },
  ];

  it('shares with an existing organization', async () => {
    const user = userEvent.setup();
    const { store } = setup(unshared(), { snapshot: { orgs } });
    expect(screen.getByText('Only you can use Payments')).toBeInTheDocument();
    expect(screen.getByText('You were invited')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Share with Acme' }));
    expect(store.linkProject).toHaveBeenCalledWith(IDS.project, IDS.org);
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    expect(store.acceptInvite).toHaveBeenCalledWith('o2');
  });

  it('creates an organization and shares it', async () => {
    const user = userEvent.setup();
    const { store } = setup(unshared(), {
      snapshot: { orgs: [] },
      methods: { createOrg: vi.fn(async () => ({ id: IDS.org })) },
    });
    expect(screen.getByText(/aren't in an organization yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create and share' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the organization a name.');
    await user.type(screen.getByLabelText('New organization'), 'Acme Eng');
    await user.click(screen.getByRole('button', { name: 'Create and share' }));
    await waitFor(() => expect(store.linkProject).toHaveBeenCalledWith(IDS.project, IDS.org));
    expect(store.createOrg).toHaveBeenCalledWith('Acme Eng');
  });

  it('shows share errors in plain language', async () => {
    const user = userEvent.setup();
    setup(unshared(), {
      snapshot: { orgs },
      methods: { linkProject: vi.fn().mockRejectedValue(new TeamError(429, 'x')) },
    });
    await user.click(screen.getByRole('button', { name: 'Share with Acme' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many changes');
  });

  it('handles organization list loading and failure', async () => {
    const user = userEvent.setup();
    const a = setup(unshared(), { snapshot: { orgsStatus: 'loading', orgs: [] } });
    expect(screen.getByText('Loading your organizations…')).toBeInTheDocument();
    a.unmount();
    const b = setup(unshared(), {
      snapshot: { orgsStatus: 'failed', orgsError: 'Teams broke', orgs: [] },
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(b.store.loadOrgs).toHaveBeenCalled();
  });

  it('tells non-owners only the owner can share', () => {
    const sync = fakeSync({ projects: [project({ owner: false })] });
    setup(unshared(), { snapshot: { orgs }, sync });
    expect(screen.getByText(/Only the project's owner can share it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share with Acme' })).toBeDisabled();
    expect(screen.queryByLabelText('New organization')).toBeNull();
  });
});

describe('ProjectAccess matrix', () => {
  it('lists people with a level per environment', () => {
    setup(ready());
    expect(screen.getByRole('heading', { name: 'Payments · Access' })).toBeInTheDocument();
    expect(screen.getByLabelText('riya@acme.dev in Development')).toHaveValue('use');
    expect(screen.getByLabelText('riya@acme.dev in Production')).toHaveValue('none');
    expect(screen.getAllByText(/· you/).length).toBeGreaterThan(0);
  });

  it('grants a level and reports a failure', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready(), {
      methods: {
        grant: vi.fn().mockRejectedValueOnce(new TeamError(403, 'x')).mockResolvedValue(undefined),
      },
    });
    const select = screen.getByLabelText('riya@acme.dev in Development');
    await user.selectOptions(select, 'edit');
    expect(await screen.findByRole('alert')).toHaveTextContent('Only managers/owners');
    await user.selectOptions(select, 'edit');
    await waitFor(() => expect(store.grant).toHaveBeenCalledTimes(2));
    expect(store.grant).toHaveBeenLastCalledWith(
      IDS.project,
      { type: 'account', id: IDS.riya },
      'edit',
      [IDS.dev],
      null,
    );
  });

  it('revokes when set to Not set', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.selectOptions(screen.getByLabelText('riya@acme.dev in Development'), '');
    await waitFor(() =>
      expect(store.revoke).toHaveBeenCalledWith(IDS.project, { type: 'account', id: IDS.riya }, [
        IDS.dev,
      ]),
    );
  });

  it('removes a person everywhere after confirming', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev from Payments' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev from Payments' }));
    expect(screen.getByText('Remove everywhere?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(store.revoke).toHaveBeenCalled());
    expect(vi.mocked(store.revoke).mock.calls[0]![2]).toEqual([IDS.dev, IDS.prod]);
  });

  it('disables cells for environments the account does not manage', () => {
    const t = ready({
      org: { ...org(), role: 'member' },
      envs: {
        [IDS.dev]: envAccess(IDS.dev, { myLevel: 'use' }),
        [IDS.prod]: envAccess(IDS.prod, { myLevel: 'use' }),
      },
    });
    setup(t);
    expect(screen.getByLabelText('riya@acme.dev in Development')).toBeDisabled();
    expect(screen.getAllByText(/Only managers\/owners can change this/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Add people, groups or agents/ })).toBeDisabled();
  });

  it('shows an empty matrix message', () => {
    const a = access();
    a.rows = [];
    setup(
      ready({
        access: a,
        envs: {
          [IDS.dev]: envAccess(IDS.dev, { grants: [] }),
          [IDS.prod]: envAccess(IDS.prod, { grants: [] }),
        },
      }),
    );
    expect(screen.getByText(/Nobody has access to any environment yet/)).toBeInTheDocument();
  });

  it('shows a grant expiry date', () => {
    const a = access();
    a.rows[1]!.cells[0]!.expiresAt = '2030-05-04T10:00:00.000Z';
    setup(ready({ access: a }));
    expect(screen.getByText(/ends/)).toBeInTheDocument();
  });

  it('adds access for a candidate through the sheet', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.click(screen.getByRole('button', { name: /Add people, groups or agents/ }));
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getByText('Add access')).toBeInTheDocument();
    await user.selectOptions(sheet.getByLabelText('Who'), 'group:' + IDS.group);
    await user.selectOptions(sheet.getByLabelText('Level'), 'edit');
    await user.click(sheet.getByRole('button', { name: 'Production' }));
    await user.click(sheet.getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(store.grant).toHaveBeenCalled());
    expect(store.grant).toHaveBeenCalledWith(
      IDS.project,
      { type: 'group', id: IDS.group },
      'edit',
      [IDS.dev],
      null,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('adds a person with an end date, and an agent without one', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready(), {
      methods: {
        grant: vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined),
      },
    });
    await user.click(screen.getByRole('button', { name: /Add people, groups or agents/ }));
    const sheet = within(screen.getByRole('dialog'));
    await user.selectOptions(sheet.getByLabelText('Who'), 'account:' + IDS.sam);
    await user.type(sheet.getByLabelText('Access ends (optional)'), '2099-01-02');
    await user.click(sheet.getByRole('button', { name: 'Give access' }));
    expect(await sheet.findByRole('alert')).toHaveTextContent('denied');
    await user.click(sheet.getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(store.grant).toHaveBeenCalledTimes(2));
    const expires = vi.mocked(store.grant).mock.calls[1]![4];
    expect(expires).toMatch(/^2099-01-0[23]T/);

    await user.click(screen.getByRole('button', { name: /Add people, groups or agents/ }));
    const second = within(screen.getByRole('dialog'));
    await user.selectOptions(second.getByLabelText('Who'), 'agent:' + IDS.bot);
    expect(second.getByText(/ask each time/)).toBeInTheDocument();
    expect(second.queryByLabelText('Access ends (optional)')).toBeNull();
    await user.click(second.getByRole('button', { name: 'Production' }));
    await user.click(second.getByRole('button', { name: 'Development' }));
    expect(second.getByRole('button', { name: 'Give access' })).toBeDisabled();
    await user.click(second.getByRole('button', { name: 'Cancel' }));
  });
});

describe('ProjectAccess rotation and hand-over', () => {
  it('rotates a flagged environment', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    expect(screen.getByText('Rotation needed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    expect(screen.getByText(/re-sealed under a new key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    await user.click(screen.getByRole('button', { name: 'Rotate now' }));
    await waitFor(() => expect(store.rotate).toHaveBeenCalledWith(IDS.project, IDS.prod, IDS.me));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rotate now' })).toBeNull());
  });

  it('shows a rotation failure', async () => {
    const user = userEvent.setup();
    setup(ready(), {
      methods: { rotate: vi.fn().mockRejectedValue(new Error('rotation failed')) },
    });
    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    await user.click(screen.getByRole('button', { name: 'Rotate now' }));
    expect(await screen.findByText('rotation failed')).toBeInTheDocument();
  });

  it('explains why rotation is unavailable', () => {
    setup(
      ready({
        envs: {
          [IDS.dev]: envAccess(IDS.dev),
          [IDS.prod]: envAccess(IDS.prod, { myLevel: 'use' }),
        },
      }),
    );
    expect(screen.getByRole('button', { name: 'Rotate key' })).toHaveAttribute(
      'title',
      'Only managers of this environment can rotate its key',
    );
  });

  it('explains rotation when this device lacks the key', () => {
    const p = project();
    p.environments[1]!.locked = true;
    setup(ready(), { sync: fakeSync({ projects: [p] }) });
    expect(screen.getByRole('button', { name: 'Rotate key' })).toHaveAttribute(
      'title',
      'This device doesn’t hold this environment’s key',
    );
  });

  it('hands over keys to members waiting for them', async () => {
    const user = userEvent.setup();
    const a = access();
    a.pendingProjectWraps = [{ accountId: IDS.riya, publicKey: KEY } as never];
    const { store } = setup(ready({ access: a }));
    expect(screen.getByText('Waiting for their key')).toBeInTheDocument();
    expect(screen.getAllByText('riya@acme.dev').length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: 'Hand over keys' }));
    expect(store.handOverKeys).toHaveBeenCalledWith(IDS.project);
  });

  it('shows hand-over progress, skipped environments and errors', () => {
    const a = access();
    a.pendingProjectWraps = [{ accountId: IDS.riya, publicKey: KEY } as never];
    const handOver: KeyHandOver = { step: 'Production', error: null, skipped: [] };
    const first = setup(ready({ access: a }), {
      snapshot: { handOvers: { [IDS.project]: handOver } },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Wrapping the key for Production');
    expect(screen.getByRole('button', { name: 'Handing over…' })).toBeDisabled();
    first.unmount();
    setup(ready({ access: a }), {
      snapshot: {
        handOvers: {
          [IDS.project]: { step: null, error: 'Wrap failed', skipped: ['Development'] },
        },
      },
    });
    expect(screen.getByText(/doesn't hold the key for Development/)).toBeInTheDocument();
    expect(screen.getByText('Wrap failed')).toBeInTheDocument();
  });
});

describe('Access requests', () => {
  it('lets a manager approve or deny pending requests', async () => {
    const user = userEvent.setup();
    const r = request();
    const { store } = setup(ready({ requests: { [IDS.prod]: [r] } }));
    expect(
      screen.getByText('Needs approval', { selector: '.section-label span' }),
    ).toBeInTheDocument();
    expect(screen.getByText('zv://payments/production/STRIPE_KEY')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(store.deny).toHaveBeenCalledWith(IDS.project, IDS.req);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(store.approve).toHaveBeenCalledWith(IDS.project, r);
  });

  it('shows approve errors and disables approval without the key', async () => {
    const user = userEvent.setup();
    const a = setup(ready({ requests: { [IDS.prod]: [request()] } }), {
      methods: { approve: vi.fn().mockRejectedValue(new Error('no value to release')) },
    });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('no value to release')).toBeInTheDocument();
    a.unmount();
    const p = project();
    p.environments[1]!.locked = true;
    setup(ready({ requests: { [IDS.prod]: [request()] } }), { sync: fakeSync({ projects: [p] }) });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows deny errors', async () => {
    const user = userEvent.setup();
    setup(ready({ requests: { [IDS.prod]: [request()] } }), {
      methods: { deny: vi.fn().mockRejectedValue(new Error('deny failed')) },
    });
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('deny failed')).toBeInTheDocument();
  });

  it("lists this account's own requests and copies a released value", async () => {
    const user = userEvent.setup();
    const mine = request({
      requester: { type: 'account', id: IDS.me },
      status: 'approved',
      release: {} as never,
    });
    const waiting = request({
      id: crypto.randomUUID(),
      requester: { type: 'account', id: IDS.me },
    });
    const { store } = setup(ready({ requests: { [IDS.prod]: [mine, waiting] } }));
    expect(screen.getByText('Your requests')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(store.releasedValue).toHaveBeenCalledWith(mine, 'zv://payments/production/STRIPE_KEY');
  });
});

describe('Organization panels', () => {
  it('shows members, groups and agents', () => {
    setup(ready());
    expect(screen.getByText('Organization · Acme')).toBeInTheDocument();
    expect(screen.getByText('Invited, hasn’t joined yet')).toBeInTheDocument();
    expect(screen.getAllByText(/Backend/).length).toBeGreaterThan(0);
    expect(screen.getByText('CI bot')).toBeInTheDocument();
    expect(screen.getByText(/Paired by me@acme.dev/)).toBeInTheDocument();
  });

  it('changes a role, removes a member after confirming', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.selectOptions(screen.getByLabelText('Role of riya@acme.dev'), 'admin');
    expect(store.changeRole).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.riya, 'admin');
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev' }));
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev' }));
    await waitFor(() =>
      expect(store.removeMember).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.riya),
    );
  });

  it('manages group membership and deletes groups', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.click(screen.getByRole('button', { name: 'Remove riya@acme.dev from Backend' }));
    expect(store.removeFromGroup).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.group, IDS.riya);
    await user.selectOptions(screen.getByLabelText('Add someone to Backend'), IDS.me);
    expect(store.addToGroup).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.group, IDS.me);
    await user.click(screen.getByRole('button', { name: 'Delete Backend' }));
    await user.click(screen.getByRole('button', { name: 'Delete Backend' }));
    await waitFor(() =>
      expect(store.deleteGroup).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.group),
    );
  });

  it('creates a group', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await user.type(screen.getByLabelText('New group name'), 'Ops{Enter}');
    await waitFor(() =>
      expect(store.createGroup).toHaveBeenCalledWith(IDS.project, IDS.org, 'Ops'),
    );
  });

  it('removes an agent after confirming and reports errors', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready(), {
      methods: { removeAgent: vi.fn().mockRejectedValue(new Error('agent stuck')) },
    });
    await user.click(screen.getByRole('button', { name: 'Remove CI bot' }));
    await user.click(screen.getByRole('button', { name: 'Remove CI bot' }));
    expect(await screen.findByText('agent stuck')).toBeInTheDocument();
    expect(store.removeAgent).toHaveBeenCalledWith(IDS.project, IDS.org, IDS.bot);
  });

  it('shows empty groups and agents', () => {
    const o = org();
    o.groups = [];
    o.agents = [];
    setup(ready({ org: o }));
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
    expect(screen.getByText(/No agents are registered/)).toBeInTheDocument();
  });

  it('is read only for regular members', () => {
    const o = org();
    o.role = 'member';
    setup(ready({ org: o }));
    expect(screen.getByText(/Owners and admins manage the team/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New group name')).toBeNull();
    expect(screen.queryByLabelText('Role of riya@acme.dev')).toBeNull();
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
  });
});

describe('Invite sheet', () => {
  it('invites a person as admin', async () => {
    const user = userEvent.setup();
    const { store } = setup(ready());
    await user.click(screen.getByRole('button', { name: 'Invite people' }));
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getByRole('button', { name: 'Send invite' })).toBeDisabled();
    await user.type(sheet.getByLabelText('Email'), ' new@acme.dev ');
    await user.click(sheet.getByRole('radio', { name: 'Admin' }));
    await user.click(sheet.getByRole('button', { name: 'Send invite' }));
    await waitFor(() =>
      expect(store.invite).toHaveBeenCalledWith(IDS.project, IDS.org, {
        email: 'new@acme.dev',
        role: 'admin',
      }),
    );
    expect(await sheet.findByText(/Invited new@acme.dev/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an invite error', async () => {
    const user = userEvent.setup();
    setup(ready(), {
      methods: { invite: vi.fn().mockRejectedValue(new TeamError(404, 'No such account')) },
    });
    await user.click(screen.getByRole('button', { name: 'Invite people' }));
    await user.type(screen.getByLabelText('Email'), 'x@y.co');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('No such account')).toBeInTheDocument();
  });
});

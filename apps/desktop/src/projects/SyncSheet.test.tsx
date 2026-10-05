/* eslint-disable @typescript-eslint/unbound-method -- test doubles */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SyncTarget } from '@zvault/shared';
import { IDS, project } from '../test/projectsFixtures.js';
import { fakeSecretSyncer, fakeSync, renderWithProjects } from '../test/projectsHarness.js';
import type { SecretSyncSnapshot } from './secretSync.js';
import { SyncSheet } from './SyncSheet.js';

const GH: SyncTarget = { provider: 'github', repo: 'acme/api', environment: 'prod', id: 'g1' };
const AWS: SyncTarget = {
  provider: 'aws',
  id: 'a1',
  region: 'ap-south-1',
  secretName: 'x/y',
  auto: false,
};

function setup(
  targets: SyncTarget[] = [],
  opts: {
    canManage?: boolean;
    snapshot?: Partial<SecretSyncSnapshot>;
    syncerMethods?: Record<string, unknown>;
    locked?: boolean;
    syncMethods?: Record<string, unknown>;
  } = {},
) {
  const p = project();
  p.environments[0]!.sync = targets;
  p.environments[0]!.locked = opts.locked ?? false;
  const sync = fakeSync({ projects: [p] }, opts.syncMethods);
  const secretSync = fakeSecretSyncer(
    { connections: { github: 'octocat', aws: null }, ...opts.snapshot },
    opts.syncerMethods,
  );
  const onClose = vi.fn();
  renderWithProjects(
    <SyncSheet
      project={p}
      env={p.environments[0]!}
      canManage={opts.canManage ?? true}
      onClose={onClose}
    />,
    { sync, secretSync },
  );
  return { sync, secretSync, onClose };
}

const iso = () => new Date().toISOString();

describe('SyncSheet', () => {
  it('invites adding a first target', () => {
    setup();
    expect(screen.getByText('Not syncing anywhere yet')).toBeInTheDocument();
    expect(screen.getByText('1 secret', { exact: false })).toBeInTheDocument();
  });

  it('shows each target with its status and syncs now', async () => {
    const user = userEvent.setup();
    const { secretSync } = setup([GH, AWS], {
      snapshot: {
        status: {
          g1: { state: 'synced', at: iso(), message: '3 pushed', fingerprint: '', names: [] },
        },
      },
    });
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByText(/3 pushed/)).toBeInTheDocument();
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();
    expect(screen.getByText('Syncs only on Sync now')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Sync now/ })[0]!);
    expect(secretSync.syncTarget).toHaveBeenCalledWith(IDS.project, IDS.dev, 'g1');
    await user.click(screen.getByRole('button', { name: /Sync all now/ }));
    expect(secretSync.syncEnvironment).toHaveBeenCalledWith(IDS.project, IDS.dev);
  });

  it('describes syncing, partial, failed and waiting states', () => {
    setup(
      [
        GH,
        { ...GH, id: 'g2', repo: 'a/b' },
        { ...GH, id: 'g3', repo: 'a/c' },
        { ...GH, id: 'g4', repo: 'a/d' },
      ],
      {
        snapshot: {
          status: {
            g1: { state: 'syncing', at: iso(), message: '', fingerprint: '', names: [] },
            g2: { state: 'partial', at: iso(), message: 'half', fingerprint: '', names: [] },
            g3: { state: 'failed', at: iso(), message: 'nope', fingerprint: '', names: [] },
          },
        },
      },
    );
    expect(screen.getByText('Syncing…', { selector: 'span.row-sub' })).toBeInTheDocument();
    expect(screen.getByText('Partly synced')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the first sync')).toBeInTheDocument();
  });

  it('removes a target', async () => {
    const user = userEvent.setup();
    const { sync } = setup([GH, AWS]);
    await user.click(screen.getAllByRole('button', { name: /Stop syncing to/ })[0]!);
    await waitFor(() => expect(sync.setSyncTargets).toHaveBeenCalled());
    expect(vi.mocked(sync.setSyncTargets).mock.calls[0]![2]).toEqual([AWS]);
  });

  it('is read only for non-managers and locked environments', () => {
    setup([GH], { canManage: false, locked: true });
    expect(screen.queryByRole('button', { name: /Stop syncing/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a place/ })).toBeNull();
    expect(screen.getByText(/Only the project owner or an admin can change/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Sync all now/ })).toBeDisabled();
  });

  it('adds a GitHub target, normalizing the repository URL', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.click(screen.getByRole('button', { name: /Add a place to sync to/ }));
    await user.type(screen.getByLabelText('Repository'), 'https://github.com/acme/web.git');
    await user.type(screen.getByLabelText('GitHub environment (optional)'), 'staging');
    await user.click(screen.getByLabelText(/Sync automatically/));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sync.setSyncTargets).toHaveBeenCalled());
    expect(
      ((sync.setSyncTargets as ReturnType<typeof vi.fn>).mock.calls[0]![2] as unknown[])[0],
    ).toMatchObject({
      provider: 'github',
      repo: 'acme/web',
      environment: 'staging',
      auto: false,
    });
    await waitFor(() => expect(screen.queryByLabelText('Repository')).toBeNull());
  });

  it('adds an AWS target', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.click(screen.getByRole('button', { name: /Add a place/ }));
    await user.click(screen.getByRole('radio', { name: /AWS/ }));
    await user.type(screen.getByLabelText('Secret name'), 'pay/prod');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sync.setSyncTargets).toHaveBeenCalled());
    expect(
      ((sync.setSyncTargets as ReturnType<typeof vi.fn>).mock.calls[0]![2] as unknown[])[0],
    ).toMatchObject({
      provider: 'aws',
      region: 'ap-south-1',
      secretName: 'pay/prod',
    });
  });

  it('validates target fields and rejects duplicates', async () => {
    const user = userEvent.setup();
    setup([GH]);
    await user.click(screen.getByRole('button', { name: /Add a place/ }));
    const add = () => user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText('Repository'), 'not a repo');
    await add();
    expect(screen.getByRole('alert')).toHaveTextContent('owner/name');
    await user.clear(screen.getByLabelText('Repository'));
    await user.type(screen.getByLabelText('Repository'), 'acme/api');
    await user.type(screen.getByLabelText('GitHub environment (optional)'), 'prod');
    await add();
    expect(screen.getByRole('alert')).toHaveTextContent('already syncs there');

    await user.click(screen.getByRole('radio', { name: /AWS/ }));
    await user.clear(screen.getByLabelText('Region'));
    await user.type(screen.getByLabelText('Region'), 'mars');
    await add();
    expect(screen.getByRole('alert')).toHaveTextContent('AWS region');
    await user.clear(screen.getByLabelText('Region'));
    await user.type(screen.getByLabelText('Region'), 'eu-west-1');
    await user.type(screen.getByLabelText('Secret name'), 'bad name!');
    await add();
    expect(screen.getByRole('alert')).toHaveTextContent('letters, digits');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Secret name')).toBeNull();
  });

  it('shows a save error', async () => {
    const user = userEvent.setup();
    setup([], {
      syncMethods: { setSyncTargets: vi.fn().mockRejectedValue(new Error('save failed')) },
    });
    await user.click(screen.getByRole('button', { name: /Add a place/ }));
    await user.type(screen.getByLabelText('Repository'), 'acme/web');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findAllByText('save failed')).not.toHaveLength(0);
  });

  it('shows connection state and disconnects', async () => {
    const user = userEvent.setup();
    const { secretSync } = setup([GH]);
    expect(screen.getByText('Connected as octocat')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(secretSync.disconnect).toHaveBeenCalledWith('github');
  });

  it('connects GitHub with a token', async () => {
    const user = userEvent.setup();
    const { secretSync } = setup([GH], { snapshot: { connections: { github: null, aws: null } } });
    expect(screen.getByText(/Not connected. Needs a fine-grained token/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const connect = screen.getAllByRole('button', { name: 'Connect' }).at(-1)!;
    expect(connect).toBeDisabled();
    await user.type(screen.getByLabelText('Personal access token'), ' ghp_x ');
    await user.click(connect);
    await waitFor(() =>
      expect(secretSync.connect).toHaveBeenCalledWith({ provider: 'github', token: 'ghp_x' }),
    );
  });

  it('connects AWS and shows a rejection', async () => {
    const user = userEvent.setup();
    const { secretSync } = setup([AWS], {
      snapshot: { connections: { github: null, aws: null } },
      syncerMethods: {
        connect: vi.fn().mockRejectedValueOnce(new Error('bad keys')).mockResolvedValue('arn'),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.type(screen.getByLabelText('Access key ID'), 'AKIA1');
    await user.type(screen.getByLabelText('Secret access key'), 'sec');
    await user.type(screen.getByLabelText('Session token (optional)'), 'sess');
    const submit = () => screen.getAllByRole('button', { name: 'Connect' }).at(-1)!;
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('bad keys');
    await user.type(screen.getByLabelText('Access key ID'), 'AKIA1');
    await user.type(screen.getByLabelText('Secret access key'), 'sec');
    await user.click(submit());
    await waitFor(() => expect(secretSync.connect).toHaveBeenCalledTimes(2));
    expect((secretSync.connect as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      provider: 'aws',
      accessKeyId: 'AKIA1',
      secretAccessKey: 'sec',
      sessionToken: 'sess',
    });
  });

  it('can cancel connecting', async () => {
    const user = userEvent.setup();
    setup([GH], { snapshot: { connections: { github: null, aws: null } } });
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const form = screen.getByLabelText('Personal access token').closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Personal access token')).toBeNull();
  });

  it('shows both providers while adding and a checking state', async () => {
    const user = userEvent.setup();
    setup([], { snapshot: { connections: null } });
    await user.click(screen.getByRole('button', { name: /Add a place/ }));
    expect(screen.getAllByText('Checking the keychain…')).toHaveLength(2);
  });

  it('closes with Done', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says when the environment disappears', () => {
    const p = project();
    const sync = fakeSync({ projects: [] });
    renderWithProjects(
      <SyncSheet project={p} env={p.environments[0]!} canManage onClose={() => undefined} />,
      { sync },
    );
    expect(screen.getByText('This environment is no longer available.')).toBeInTheDocument();
  });
});

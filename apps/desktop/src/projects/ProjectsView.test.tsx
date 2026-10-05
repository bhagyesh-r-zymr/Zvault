/* eslint-disable @typescript-eslint/unbound-method -- test doubles */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeActivity, fakeSync, fakeTeam, renderWithProjects } from '../test/projectsHarness.js';
import { IDS, access, blob, envAccess, org, project, secret } from '../test/projectsFixtures.js';
import { mockCore } from '../test/tauri.js';
import { ProjectsView } from './ProjectsView.js';
import type { ProjectTeam } from './team.js';

vi.mock('../sharing/ShareItem.js', () => ({
  ShareItem: (p: { item: { value?: string }; onShared: (c: string) => void }) => (
    <button type="button" onClick={() => p.onShared('link')}>
      share-stub
    </button>
  ),
}));

const readyTeam = (over: Partial<ProjectTeam> = {}): ProjectTeam => ({
  status: 'ready',
  error: null,
  access: access(),
  org: org(),
  envs: { [IDS.dev]: envAccess(IDS.dev), [IDS.prod]: envAccess(IDS.prod) },
  requests: {},
  ...over,
});

function setup(
  props: Partial<Parameters<typeof ProjectsView>[0]> = {},
  extra: Parameters<typeof renderWithProjects>[1] = {},
) {
  const handlers = { onEnvChange: vi.fn(), onOpenProject: vi.fn(), onOpenAccess: vi.fn() };
  const out = renderWithProjects(
    <ProjectsView projectId={IDS.project} envId={IDS.dev} {...handlers} {...props} />,
    extra,
  );
  return { ...handlers, ...out };
}

beforeEach(() => {
  mockCore({ copy_secret: 30 });
});

describe('ProjectsView', () => {
  it('lists secrets, with folders, and opens the first', () => {
    const sync = fakeSync({
      secrets: [
        secret(),
        secret({
          id: 'sec-2',
          name: 'Webhook',
          key: 'WEBHOOK',
          tags: ['payments'],
          folder: project().folders[0]!,
        }),
      ],
    });
    setup({}, { sync });
    expect(screen.getByRole('heading', { level: 2, name: 'Payments' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Stripe key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Billing/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Webhook/ })).toBeInTheDocument();
  });

  it('collapses folders and filters by environment and tag', async () => {
    const user = userEvent.setup();
    const folder = project().folders[0]!;
    const sync = fakeSync({
      secrets: [
        secret(),
        secret({
          id: 'sec-2',
          name: 'Webhook',
          key: 'WEBHOOK',
          tags: ['payments'],
          folder,
          values: { [IDS.prod]: blob(IDS.prod) },
        }),
      ],
    });
    const { onEnvChange } = setup({}, { sync });
    await user.click(screen.getByRole('button', { name: /Billing/ }));
    expect(screen.queryByRole('button', { name: /Webhook/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Billing/ }));
    expect(screen.getByRole('button', { name: /Webhook/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '#payments' }));
    expect(screen.queryByRole('button', { name: /Stripe key/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '#payments' }));

    const filter = screen.getByRole('group', { name: 'Show secrets in' });
    await user.click(within(filter).getByRole('button', { name: /Dev/ }));
    expect(onEnvChange).toHaveBeenCalledWith(IDS.dev);
    // Webhook has no value in Development, so it is filtered out.
    expect(screen.queryByRole('button', { name: /Webhook/ })).toBeNull();
    await user.click(within(filter).getByRole('button', { name: /Dev/ }));
    expect(screen.getByRole('button', { name: /Webhook/ })).toBeInTheDocument();
  });

  it('shows an empty message when nothing matches', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({
      secrets: [secret({ tags: ['x'], values: { [IDS.dev]: blob(IDS.dev) } })],
    });
    setup({}, { sync });
    const filter = screen.getByRole('group', { name: 'Show secrets in' });
    await user.click(within(filter).getByRole('button', { name: /Prod/ }));
    expect(screen.getByText(/Nothing in Production/)).toBeInTheDocument();
  });

  it('shows placeholders for loading, missing and empty projects', () => {
    const loading = fakeSync({ status: 'loading', projects: [], secrets: [] });
    const { unmount } = setup({}, { sync: loading });
    expect(screen.getByText('Opening project…')).toBeInTheDocument();
    unmount();
    setup({ projectId: 'nope' });
    expect(screen.getByText('This project is no longer available.')).toBeInTheDocument();
  });

  it('offers to create the first environment when there are none', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({ projects: [project({ environments: [] })], secrets: [] });
    const { onEnvChange } = setup({}, { sync });
    expect(screen.getByText('Payments has no environments yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create environment/ }));
    await user.type(screen.getByLabelText('Name'), 'Staging');
    await user.click(screen.getAllByRole('button', { name: 'Create environment' }).at(-1)!);
    await waitFor(() => expect(onEnvChange).toHaveBeenCalledWith('new-env-id'));
    expect(sync.createEnvironment).toHaveBeenCalled();
  });

  it('tells a non-owner to ask for an environment', () => {
    const sync = fakeSync({ projects: [project({ owner: false, environments: [] })], secrets: [] });
    setup({}, { sync });
    expect(screen.getByText(/Ask the project owner/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create environment/ })).toBeNull();
  });

  it('reveals, hides and copies the value and reports activity', async () => {
    const user = userEvent.setup();
    const activity = fakeActivity();
    const sync = fakeSync();
    setup({}, { sync, activity });
    await user.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(await screen.findByText(/plainvalue/)).toBeInTheDocument();
    expect(activity.viewed).toHaveBeenCalledWith(IDS.project, IDS.secret, IDS.dev);
    await user.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText(/plainvalue/)).toBeNull();

    const copy = screen.getAllByRole('button', { name: 'Copy' })[0]!;
    await user.click(copy);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(activity.copied).toHaveBeenCalled();
  });

  it('shows a decryption error', async () => {
    const user = userEvent.setup();
    const sync = fakeSync(
      {},
      { openValue: vi.fn().mockRejectedValue(new Error('cannot decrypt')) },
    );
    setup({}, { sync });
    await user.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot decrypt');
  });

  it('switches the environment from the detail tabs', async () => {
    const user = userEvent.setup();
    const { onEnvChange } = setup();
    await user.click(screen.getByRole('tab', { name: /Prod/ }));
    expect(onEnvChange).toHaveBeenCalledWith(IDS.prod);
  });

  it('describes locked, unset and inherited environments', () => {
    const p = project();
    p.environments[0]!.locked = true;
    const sync = fakeSync({
      projects: [p],
      secrets: [secret({ values: { [IDS.prod]: blob(IDS.prod) } })],
    });
    setup({ envId: IDS.dev }, { sync });
    expect(screen.getByText(/don't have access to Development values/)).toBeInTheDocument();
  });

  it('shows "not set" and inherited values', () => {
    const p = project();
    p.environments[1]!.inheritsFrom = IDS.dev;
    const sync = fakeSync({
      projects: [p],
      secrets: [secret({ values: { [IDS.dev]: blob(IDS.dev) } })],
    });
    setup({ envId: IDS.prod }, { sync });
    expect(screen.getByText(/same as Development/)).toBeInTheDocument();
    expect(screen.getByText(/zv run --env/)).toBeInTheDocument();
  });

  it('shows not set when the environment has no value', () => {
    const sync = fakeSync({ secrets: [secret({ values: { [IDS.dev]: blob(IDS.dev) } })] });
    setup({ envId: IDS.prod }, { sync });
    expect(screen.getByText('Not set in Production.')).toBeInTheDocument();
  });

  it('deletes a secret after confirming, and reports a failure', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({}, { deleteSecret: vi.fn().mockRejectedValueOnce(new Error('nope')) });
    setup({}, { sync });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(sync.deleteSecret).toHaveBeenCalledTimes(2));
  });

  it('is view only when the team grants less than Edit', () => {
    const sync = fakeSync({ projects: [project({ owner: false })] });
    const team = fakeTeam({
      [IDS.project]: readyTeam({
        envs: { [IDS.dev]: envAccess(IDS.dev, { myLevel: 'use' }) },
      }),
    });
    setup({}, { sync, team });
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('lists who can use the secret from the team access', () => {
    const team = fakeTeam({ [IDS.project]: readyTeam() });
    setup({}, { team });
    expect(screen.getByText('Who can use it')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('riya@acme.dev')).toBeInTheDocument();
  });

  it.each([
    ['loading', { status: 'loading' as const }, /Loading/],
    ['failed', { status: 'failed' as const, error: 'Access went wrong' }, /Access went wrong/],
    ['unshared', { status: 'unshared' as const, access: null }, /Only you/],
  ])('shows the %s team state', (_n, over, text) => {
    const team = fakeTeam({ [IDS.project]: readyTeam(over) });
    setup({}, { team });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows an empty access list', () => {
    const a = access();
    a.rows = [];
    const team = fakeTeam({ [IDS.project]: readyTeam({ access: a, envs: {} }) });
    setup({}, { team });
    expect(screen.getByText(/Nobody has access to Payments yet/)).toBeInTheDocument();
  });

  it('opens the access page', async () => {
    const user = userEvent.setup();
    const { onOpenAccess } = setup();
    await user.click(screen.getByRole('button', { name: /Manage access/ }));
    expect(onOpenAccess).toHaveBeenCalled();
  });

  it('creates a secret through the New sheet', async () => {
    const user = userEvent.setup();
    const sync = fakeSync();
    const { onEnvChange } = setup({}, { sync });
    await user.click(screen.getByRole('button', { name: /New/ }));
    await user.type(screen.getByLabelText('Name'), 'Db password');
    await user.type(screen.getByLabelText('Development value'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(sync.createSecret).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('New secret')).toBeNull());
    expect(onEnvChange).not.toHaveBeenCalled();
  });

  it('shares a value from an environment this account can read', async () => {
    const user = userEvent.setup();
    const activity = fakeActivity();
    const sharing = {} as never;
    setup({ sharing }, { activity });
    await user.click(screen.getByRole('button', { name: /Share/ }));
    expect(await screen.findByText('Share Stripe key')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'share-stub' }));
    expect(activity.shared).toHaveBeenCalledWith(IDS.project, IDS.secret, IDS.dev, 'link');
    // Pick another environment to share.
    const group = screen.getByRole('group', { name: 'Environment to share' });
    await user.click(within(group).getByRole('button', { name: /Production/ }));
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: /Production/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Share Stripe key')).toBeNull();
  });

  it('shows an error when the value to share cannot be decrypted', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({}, { openValue: vi.fn().mockRejectedValue(new Error('locked out')) });
    setup({ sharing: {} as never }, { sync });
    await user.click(screen.getByRole('button', { name: /Share/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('locked out');
  });

  it('opens the history sheet', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /History/ }));
    expect(await screen.findByText('History of Stripe key')).toBeInTheDocument();
    expect(await screen.findByText(/No earlier versions yet/)).toBeInTheDocument();
  });

  it('opens the secret named by secretId', () => {
    const sync = fakeSync({
      secrets: [secret(), secret({ id: 'sec-2', name: 'Webhook', key: 'WEBHOOK' })],
    });
    setup({ secretId: 'sec-2' }, { sync });
    expect(screen.getByRole('heading', { level: 1, name: 'Webhook' })).toBeInTheDocument();
  });

  it('selects another secret from the list', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({
      secrets: [secret(), secret({ id: 'sec-2', name: 'Webhook', key: 'WEBHOOK' })],
    });
    setup({}, { sync });
    await user.click(screen.getByRole('button', { name: /Webhook/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Webhook' })).toBeInTheDocument();
  });
});

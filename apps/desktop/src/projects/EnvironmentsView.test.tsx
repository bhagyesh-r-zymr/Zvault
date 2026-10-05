/* eslint-disable @typescript-eslint/unbound-method -- test doubles */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS, access, envAccess, org, project, secret } from '../test/projectsFixtures.js';
import {
  fakeSecretSyncer,
  fakeSync,
  fakeTeam,
  renderWithProjects,
} from '../test/projectsHarness.js';
import { EnvironmentsView } from './EnvironmentsView.js';

function setup(opts: Parameters<typeof renderWithProjects>[1] = {}, projectId = IDS.project) {
  const onOpenEnvironment = vi.fn();
  renderWithProjects(
    <EnvironmentsView projectId={projectId} onOpenEnvironment={onOpenEnvironment} />,
    opts,
  );
  return { onOpenEnvironment };
}

describe('EnvironmentsView', () => {
  it('lists environments and opens one', async () => {
    const user = userEvent.setup();
    const { onOpenEnvironment } = setup();
    expect(screen.getByRole('heading', { name: 'Payments · Environments' })).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
    expect(onOpenEnvironment).toHaveBeenCalledWith(IDS.prod);
  });

  it('says when the project is gone', () => {
    setup({}, 'missing');
    expect(screen.getByText('This project is no longer available.')).toBeInTheDocument();
  });

  it('creates the first environment and opens it', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({ projects: [project({ environments: [] })], secrets: [] });
    const { onOpenEnvironment } = setup({ sync });
    expect(screen.getByText('No environments yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create environment/ }));
    await user.type(screen.getByLabelText('Name'), 'Staging Env');
    expect(screen.getByLabelText('Slug')).toHaveValue('staging-env');
    await user.click(screen.getAllByRole('button', { name: 'Create environment' }).at(-1)!);
    await waitFor(() => expect(onOpenEnvironment).toHaveBeenCalledWith('new-env-id'));
    expect(sync.createEnvironment).toHaveBeenCalledWith(IDS.project, {
      name: 'Staging Env',
      slug: 'staging-env',
      kind: 'custom',
      inheritsFrom: null,
    });
  });

  it('hides management from non-owners', () => {
    const sync = fakeSync({ projects: [project({ owner: false, environments: [] })] });
    setup({ sync });
    expect(screen.getByText(/Only the project owner or an admin can add/)).toBeInTheDocument();
    const withEnvs = fakeSync({ projects: [project({ owner: false })] });
    setup({ sync: withEnvs });
    expect(screen.getByText(/Only the project owner or an organization admin/)).toBeInTheDocument();
  });

  it('lets an org admin manage a shared project', () => {
    const team = fakeTeam({
      [IDS.project]: {
        status: 'ready',
        error: null,
        access: access(),
        org: org(),
        envs: { [IDS.dev]: envAccess(IDS.dev) },
        requests: {},
      },
    });
    setup({ sync: fakeSync({ projects: [project({ owner: false })] }), team });
    expect(screen.getAllByRole('button', { name: /Edit/ })).toHaveLength(2);
  });

  it('edits an environment, with a warning when the slug changes', async () => {
    const user = userEvent.setup();
    const sync = fakeSync();
    setup({ sync });
    await user.click(screen.getAllByRole('button', { name: /Edit/ })[0]!);
    const slug = screen.getByLabelText('Slug');
    await user.clear(slug);
    await user.type(slug, 'Dev Env!');
    expect(slug).toHaveValue('dev-env-');
    expect(screen.getByText(/Scripts using the old slug/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Staging/ }));
    await user.selectOptions(screen.getByLabelText('When a secret has no value here'), IDS.prod);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sync.updateEnvironment).toHaveBeenCalledWith(IDS.project, IDS.dev, {
        name: 'Development',
        slug: 'dev-env-',
        kind: 'staging',
        inheritsFrom: IDS.prod,
      }),
    );
  });

  it('validates the environment form and reports save errors', async () => {
    const user = userEvent.setup();
    const sync = fakeSync(
      {},
      { createEnvironment: vi.fn().mockRejectedValue(new Error('slug taken')) },
    );
    setup({ sync });
    await user.click(screen.getByRole('button', { name: /New environment/ }));
    const create = () => screen.getByRole('button', { name: 'Create environment' });
    await user.click(create());
    expect(screen.getByRole('alert')).toHaveTextContent('Give the environment a name.');
    await user.type(screen.getByLabelText('Name'), '***');
    await user.click(create());
    expect(screen.getByRole('alert')).toHaveTextContent('Give it a slug');
    await user.type(screen.getByLabelText('Slug'), 'qa');
    await user.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent('slug taken');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('New environment', { selector: 'h2, h3, [id]' })).toBeNull();
  });

  it('confirms before deleting and explains the consequence', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({}, { secretsOnlyIn: vi.fn(() => ['a', 'b']) });
    setup({ sync });
    await user.click(screen.getByRole('button', { name: 'Delete Development' }));
    expect(
      screen.getByText(/Its value and key go with it\. 2 secrets have no value/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete Development' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sync.deleteEnvironment).toHaveBeenCalledWith(IDS.project, IDS.dev));
  });

  it('describes deletion of empty, plural and locked environments', async () => {
    const user = userEvent.setup();
    const p = project();
    p.environments[1]!.locked = true;
    const sync = fakeSync(
      { projects: [p], secrets: [secret({ values: {} }), secret({ id: 's2', values: {} })] },
      { secretsOnlyIn: vi.fn(() => ['a']) },
    );
    setup({ sync });
    await user.click(screen.getByRole('button', { name: 'Delete Development' }));
    expect(screen.getByText(/It holds no values\. 1 secret has no value/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete Production' }));
    expect(screen.getByText(/Its values go with it\./)).toBeInTheDocument();
  });

  it('shows plural values', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({
      secrets: [secret(), secret({ id: 's2', name: 'B', key: 'B' })],
    });
    setup({ sync });
    await user.click(screen.getByRole('button', { name: 'Delete Development' }));
    expect(screen.getByText(/Its 2 values and key/)).toBeInTheDocument();
  });

  it('shows a delete failure', async () => {
    const user = userEvent.setup();
    const sync = fakeSync(
      {},
      { deleteEnvironment: vi.fn().mockRejectedValue(new Error('refused')) },
    );
    setup({ sync });
    await user.click(screen.getByRole('button', { name: 'Delete Development' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('refused');
  });

  it('shows sync targets with their health and opens the sync sheet', async () => {
    const user = userEvent.setup();
    const p = project();
    p.environments[0]!.sync = [
      { provider: 'github', id: 'g1', repo: 'acme/api' },
      { provider: 'aws', id: 'a1', region: 'ap-south-1', secretName: 'x/y' },
    ];
    p.environments[1]!.sync = [{ provider: 'github', id: 'g2', repo: 'acme/web' }];
    const secretSync = fakeSecretSyncer({
      status: {
        g1: {
          state: 'failed',
          at: new Date().toISOString(),
          message: 'bad',
          fingerprint: '',
          names: [],
        },
        a1: {
          state: 'partial',
          at: new Date().toISOString(),
          message: 'half',
          fingerprint: '',
          names: [],
        },
        g2: {
          state: 'synced',
          at: new Date().toISOString(),
          message: 'ok',
          fingerprint: '',
          names: [],
        },
      },
    });
    setup({ sync: fakeSync({ projects: [p] }), secretSync });
    const button = screen.getByRole('button', { name: /Synced to 2/ });
    expect(button).toHaveClass('failed');
    expect(screen.getByRole('button', { name: /Synced to 1/ })).not.toHaveClass('failed');
    await user.click(button);
    expect(await screen.findByText('Sync Development')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Sync Development')).toBeNull();
  });

  it('marks partly synced environments and shows fallbacks', () => {
    const p = project();
    p.environments[0]!.sync = [{ provider: 'github', id: 'g1', repo: 'acme/api' }];
    p.environments[1]!.inheritsFrom = IDS.dev;
    p.environments[1]!.locked = true;
    const secretSync = fakeSecretSyncer({
      status: {
        g1: {
          state: 'partial',
          at: new Date().toISOString(),
          message: 'half',
          fingerprint: '',
          names: [],
        },
      },
    });
    setup({ sync: fakeSync({ projects: [p] }), secretSync });
    expect(screen.getByRole('button', { name: /Synced to 1/ })).toHaveClass('partial');
    expect(screen.getByText(/falls back to Development/)).toBeInTheDocument();
    expect(
      within(screen.getByText('Production').closest('.row')!).getByLabelText('No access'),
    ).toBeInTheDocument();
  });
});

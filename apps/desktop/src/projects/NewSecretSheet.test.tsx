/* eslint-disable @typescript-eslint/unbound-method -- test doubles */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS, envAccess, project } from '../test/projectsFixtures.js';
import { fakeSync, fakeTeam, renderWithProjects } from '../test/projectsHarness.js';
import { ApiError } from './api.js';
import { NewSecretSheet } from './NewSecretSheet.js';

function setup(sync = fakeSync(), team = fakeTeam()) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  renderWithProjects(
    <NewSecretSheet project={sync.get().projects[0]!} onClose={onClose} onCreated={onCreated} />,
    { sync, team },
  );
  return { sync, onClose, onCreated };
}

describe('NewSecretSheet', () => {
  it('derives the variable name and saves values per environment', async () => {
    const user = userEvent.setup();
    const { sync, onCreated } = setup();
    await user.type(screen.getByLabelText('Name'), 'Stripe secret key');
    expect(screen.getByLabelText('Variable name for zv run')).toHaveValue('STRIPE_SECRET_KEY');
    await user.type(screen.getByLabelText('Development value'), ' dev ');
    await user.type(screen.getByLabelText('Production value'), 'prod');
    await user.type(screen.getByLabelText('Tags'), 'Third Party{Enter}');
    await user.click(screen.getByRole('button', { name: '#aws' }));
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(sync.createSecret).toHaveBeenCalledWith(IDS.project, {
      name: 'Stripe secret key',
      key: 'STRIPE_SECRET_KEY',
      folderId: null,
      tags: ['third-party', 'aws'],
      values: { [IDS.dev]: 'dev', [IDS.prod]: 'prod' },
    });
    expect(onCreated).toHaveBeenCalledWith({
      projectId: IDS.project,
      secretId: 'new-secret-id',
      envIds: [IDS.dev, IDS.prod],
    });
  });

  it('keeps an edited variable name and manages tags with the keyboard', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Name'), 'A');
    const env = screen.getByLabelText('Variable name for zv run');
    await user.clear(env);
    await user.type(env, 'custom');
    expect(env).toHaveValue('CUSTOM');
    await user.type(screen.getByLabelText('Name'), 'b');
    expect(env).toHaveValue('CUSTOM');
    const tags = screen.getByLabelText('Tags');
    await user.type(tags, 'one,two');
    await user.keyboard(',');
    expect(screen.getByText('#one')).toBeInTheDocument();
    await user.type(tags, '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Remove tag one' }));
    expect(screen.queryByText('#one')).toBeNull();
  });

  it('validates name, variable and values', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    const save = () => user.click(screen.getByRole('button', { name: 'Save secret' }));
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent('Give the secret a name.');
    await user.type(screen.getByLabelText('Name'), '123');
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent('variable name');
    const varName = screen.getByLabelText('Variable name for zv run');
    await user.clear(varName);
    await user.type(varName, 'KEY');
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent('at least one environment');
    expect(sync.createSecret).not.toHaveBeenCalled();
  });

  it('uses an existing folder by name', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.type(screen.getByLabelText('Name'), 'K');
    await user.type(screen.getByLabelText('Development value'), 'v');
    await user.type(screen.getByLabelText('Folder (optional)'), 'billing');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(sync.createSecret).toHaveBeenCalled());
    expect(sync.createFolder).not.toHaveBeenCalled();
    expect((sync.createSecret as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      folderId: IDS.folder,
    });
  });

  it('creates a missing folder as the owner', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.type(screen.getByLabelText('Name'), 'K');
    await user.type(screen.getByLabelText('Development value'), 'v');
    await user.type(screen.getByLabelText('Folder (optional)'), 'Infra');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(sync.createFolder).toHaveBeenCalledWith(IDS.project, 'Infra'));
    expect((sync.createSecret as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      folderId: 'new-folder-id',
    });
  });

  it('stops non-owners from creating folders', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({ projects: [project({ owner: false })] });
    setup(sync);
    await user.type(screen.getByLabelText('Name'), 'K');
    await user.type(screen.getByLabelText('Development value'), 'v');
    await user.type(screen.getByLabelText('Folder (optional)'), 'new-folder');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Only the project owner can add folders');
    expect(screen.queryByRole('button', { name: '+ Custom environment' })).toBeNull();
  });

  it('disables locked and view-only environments', () => {
    const p = project({ owner: false });
    p.environments[0]!.locked = true;
    const sync = fakeSync({ projects: [p] });
    const team = fakeTeam({
      [IDS.project]: {
        status: 'ready',
        error: null,
        access: null,
        org: null,
        requests: {},
        envs: { [IDS.prod]: envAccess(IDS.prod, { myLevel: 'use' }) },
      },
    });
    setup(sync, team);
    expect(screen.getByLabelText('Development value')).toBeDisabled();
    expect(screen.getByLabelText('Development value')).toHaveAttribute('placeholder', 'No access');
    expect(screen.getByLabelText('Production value')).toHaveAttribute('placeholder', 'View only');
  });

  it('shows inheritance in the placeholder', () => {
    const p = project();
    p.environments[1]!.inheritsFrom = IDS.dev;
    setup(fakeSync({ projects: [p] }));
    expect(screen.getByLabelText('Production value')).toHaveAttribute(
      'placeholder',
      'Same as Development',
    );
  });

  it('adds a custom environment inline', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.click(screen.getByRole('button', { name: '+ Custom environment' }));
    await user.type(screen.getByLabelText('New environment name'), 'QA{Enter}');
    await waitFor(() => expect(sync.createEnvironment).toHaveBeenCalledWith(IDS.project, 'QA'));
    await waitFor(() => expect(screen.queryByLabelText('New environment name')).toBeNull());
  });

  it('cancels the inline environment when empty and reports failures', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({}, { createEnvironment: vi.fn().mockRejectedValue(new ApiError(404)) });
    setup(sync);
    await user.click(screen.getByRole('button', { name: '+ Custom environment' }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.type(screen.getByLabelText('New environment name'), 'QA');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
  });

  it('switches project and clears values', async () => {
    const user = userEvent.setup();
    const other = project({ id: 'other', name: 'Other', slug: 'other', environments: [] });
    const sync = fakeSync({ projects: [project(), other] });
    setup(sync);
    await user.type(screen.getByLabelText('Development value'), 'abc');
    await user.selectOptions(screen.getByLabelText('Project'), 'other');
    expect(screen.queryByLabelText('Development value')).toBeNull();
  });

  it('shows a save error and closes with Cancel', async () => {
    const user = userEvent.setup();
    const sync = fakeSync(
      {},
      { createSecret: vi.fn().mockRejectedValue(new Error('server said no')) },
    );
    const { onClose } = setup(sync);
    await user.type(screen.getByLabelText('Name'), 'K');
    await user.type(screen.getByLabelText('Development value'), 'v');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('server said no');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

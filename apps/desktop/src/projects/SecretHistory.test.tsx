/* eslint-disable @typescript-eslint/require-await -- test doubles */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeSync, renderWithProjects } from '../test/projectsHarness.js';
import { IDS, blob, project, secret } from '../test/projectsFixtures.js';
import { SecretHistory } from './SecretHistory.js';

const version = (revision: number, name = 'Stripe key') => ({
  revision,
  savedAt: '2026-01-01T10:00:00.000Z',
  meta: { name, key: 'STRIPE_KEY', folderId: null, tags: [] },
  version: {
    revision,
    savedAt: '2026-01-01T10:00:00.000Z',
    encryptedMeta: blob('m'),
    values: [{ environmentId: IDS.dev, encryptedValue: blob(IDS.dev, 'older') }],
  },
});

function setup(
  opts: { versions?: unknown[]; canEdit?: boolean; sync?: ReturnType<typeof fakeSync> } = {},
) {
  const sync =
    opts.sync ??
    fakeSync(
      {},
      { secretHistory: vi.fn(async () => opts.versions ?? [version(2), version(1, 'Old name')]) },
    );
  const onRestored = vi.fn();
  const p = project();
  p.environments[1]!.locked = true;
  renderWithProjects(
    <SecretHistory
      project={p}
      secret={secret()}
      canEdit={opts.canEdit ?? true}
      onRestored={onRestored}
    />,
    { sync },
  );
  return { sync, onRestored };
}

describe('SecretHistory', () => {
  it('lists earlier versions and marks renames', async () => {
    setup();
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Old name')).toHaveClass('changed');
    // Only readable environments are listed.
    expect(screen.getAllByText('Development')).toHaveLength(2);
    expect(screen.queryByText('Production')).toBeNull();
  });

  it('shows an empty state', async () => {
    setup({ versions: [] });
    expect(await screen.findByText(/No earlier versions yet/)).toBeInTheDocument();
  });

  it('shows an error when history cannot load', async () => {
    const sync = fakeSync(
      {},
      { secretHistory: vi.fn().mockRejectedValue(new Error('no history')) },
    );
    setup({ sync });
    expect(await screen.findByRole('alert')).toHaveTextContent('no history');
  });

  it('reveals and hides an old value', async () => {
    const user = userEvent.setup();
    setup({ versions: [version(1)] });
    const item = await screen.findByRole('listitem');
    await user.click(within(item).getByRole('button', { name: 'Reveal' }));
    expect(await within(item).findByText('oldvalue')).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Hide' }));
    expect(within(item).queryByText('oldvalue')).toBeNull();
  });

  it('reports a value that cannot be opened', async () => {
    const user = userEvent.setup();
    const sync = fakeSync(
      {},
      {
        secretHistory: vi.fn(async () => [version(1)]),
        openHistoricValue: vi.fn().mockRejectedValue(new Error('sealed')),
      },
    );
    setup({ sync });
    await user.click(await screen.findByRole('button', { name: 'Reveal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sealed');
  });

  it('restores a version, or shows why it failed', async () => {
    const user = userEvent.setup();
    const restore = vi
      .fn()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValue(undefined);
    const sync = fakeSync(
      {},
      { secretHistory: vi.fn(async () => [version(1)]), restoreSecretVersion: restore },
    );
    const { onRestored } = setup({ sync });
    await user.click(await screen.findByRole('button', { name: /Restore/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('conflict');
    await user.click(screen.getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it('hides Restore when the account cannot edit', async () => {
    setup({ canEdit: false, versions: [version(1)] });
    await screen.findByRole('listitem');
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });
});

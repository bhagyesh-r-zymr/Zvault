import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsContext } from '../projects/context.js';
import type { ProjectsSync, TrashedSecretView } from '../projects/sync.js';
import { FakeServer, login, makeCore, VAULT } from '../test/vaultFakes.js';
import { VaultSync } from '../vault/sync.js';
import { TrashView } from './TrashView.js';

const day = 24 * 3600 * 1000;
const project = {
  id: 'p1',
  slug: 'web',
  name: 'Webapp',
  owner: true,
  tile: { bg: '#123456', fg: '#fff' },
  environments: [],
  folders: [],
};

function secret(over: Partial<TrashedSecretView> = {}): TrashedSecretView {
  return {
    id: 's1',
    projectId: 'p1',
    deletedAt: new Date(Date.now() - day).toISOString(),
    purgeAt: new Date(Date.now() + 2 * day).toISOString(),
    meta: { name: 'Database', key: 'DATABASE_URL' },
    trashed: { id: 's1' },
    ...over,
  } as TrashedSecretView;
}

function fakeProjects(secrets: TrashedSecretView[]) {
  const state = { secrets };
  const snapshot = { projects: [project] };
  const sync = {
    subscribe: () => () => undefined,
    get: () => snapshot,
    trash: vi.fn(() => Promise.resolve(state.secrets)),
    purge: vi.fn((_p: string, id: string | null) => {
      state.secrets = id ? state.secrets.filter((s) => s.id !== id) : [];
      return Promise.resolve();
    }),
    restoreFromTrash: vi.fn((_p: string, t: { id: string }) => {
      state.secrets = state.secrets.filter((s) => s.id !== t.id);
      return Promise.resolve();
    }),
  };
  return sync;
}

async function setup(secrets: TrashedSecretView[] = [], items: string[] = []) {
  const server = new FakeServer();
  const core = makeCore();
  const sync = new VaultSync(server.asApi(), core, VAULT);
  for (const t of items) {
    const id = await sync.save(null, login(t));
    await sync.remove(id);
  }
  const projects = fakeProjects(secrets);
  const view = render(
    <ProjectsContext.Provider value={projects as unknown as ProjectsSync}>
      <TrashView api={server.asApi()} core={core} />
    </ProjectsContext.Provider>,
  );
  return { server, projects, sync, view };
}

describe('TrashView', () => {
  it('shows an empty trash', async () => {
    await setup();
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empty trash/ })).toBeDisabled();
  });

  it('lists deleted items and secrets with their time left', async () => {
    await setup([secret()], ['Bank']);
    expect(await screen.findByText('Bank')).toBeInTheDocument();
    expect(screen.getByText('bank@example.com')).toBeInTheDocument();
    expect(screen.getByText('Webapp')).toBeInTheDocument();
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText(/Deleted 2 days ago · 28 days left/)).toBeInTheDocument();
    expect(screen.getByText(/Deleted yesterday · 2 days left/)).toBeInTheDocument();
  });

  it('restores an item', async () => {
    const { server } = await setup([], ['Bank']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Restore/ }));
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
    expect([...server.items.values()].some((i) => !i.deleted)).toBe(true);
  });

  it('restores a secret', async () => {
    const { projects } = await setup([secret()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(projects.restoreFromTrash).toHaveBeenCalledWith('p1', { id: 's1' }));
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
  });

  it('asks before deleting an item forever, and can cancel', async () => {
    const { server } = await setup([], ['Bank']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(server.purged).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Delete forever' }));
    await user.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
    expect(server.purged).toHaveLength(1);
  });

  it('deletes a secret forever', async () => {
    const { projects } = await setup([secret()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }));
    await user.click(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(projects.purge).toHaveBeenCalledWith('p1', 's1'));
  });

  it('empties everything after confirmation', async () => {
    const { server, projects } = await setup([secret()], ['Bank', 'Shop']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Empty trash/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: /Empty trash/ }));
    await user.click(screen.getByRole('button', { name: 'Delete 3 forever' }));
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
    expect(server.purged).toContain(null);
    expect(projects.purge).toHaveBeenCalledWith('p1', null);
  });

  it('shows errors from a failed action', async () => {
    const { projects } = await setup([secret()]);
    projects.restoreFromTrash.mockRejectedValueOnce(new Error('conflict'));
    const user = userEvent.setup();
    const row = (await screen.findByText('DATABASE_URL')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Restore/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('conflict');
  });

  it('shows an error when the trash cannot be opened', async () => {
    const server = new FakeServer();
    server.listVaults = () => Promise.reject(new Error('offline'));
    render(
      <ProjectsContext.Provider value={fakeProjects([]) as unknown as ProjectsSync}>
        <TrashView api={server.asApi()} core={makeCore()} />
      </ProjectsContext.Provider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });

  it('skips items it cannot decrypt', async () => {
    const { server } = await setup([], ['Bank']);
    const core = makeCore({
      summarizeItem: () => Promise.reject(new Error('corrupt')),
    });
    render(
      <ProjectsContext.Provider value={fakeProjects([]) as unknown as ProjectsSync}>
        <TrashView api={server.asApi()} core={core} />
      </ProjectsContext.Provider>,
    );
    expect(await screen.findAllByText('The trash is empty.')).not.toHaveLength(0);
  });
});

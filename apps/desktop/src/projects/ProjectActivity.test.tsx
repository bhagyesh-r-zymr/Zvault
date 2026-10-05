/* eslint-disable @typescript-eslint/require-await -- test doubles */
import type { ActivityEvent } from '@zvault/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS, project, secret } from '../test/projectsFixtures.js';
import { fakeSync, renderWithProjects } from '../test/projectsHarness.js';
import { ApiError, ForbiddenError } from './api.js';
import { ProjectActivity, groupByDay } from './ProjectActivity.js';

let seq = 100;
const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  seq: seq--,
  at: new Date().toISOString(),
  action: 'secret.viewed',
  actor: { type: 'account', id: IDS.riya, name: 'riya@acme.dev' },
  environmentId: IDS.prod,
  targetId: IDS.secret,
  detail: {},
  ...over,
});

function setup(
  activity: ReturnType<typeof vi.fn>,
  opts: { onOpenSecret?: (s: string, e: string) => void; projectId?: string } = {},
) {
  return renderWithProjects(
    <ProjectActivity
      projectId={opts.projectId ?? IDS.project}
      api={{ activity } as never}
      email="me@acme.dev"
      {...(opts.onOpenSecret && { onOpenSecret: opts.onOpenSecret })}
    />,
    { sync: fakeSync({ projects: [project()], secrets: [secret()] }) },
  );
}

describe('ProjectActivity', () => {
  it('lists events grouped by day and opens a secret', async () => {
    const user = userEvent.setup();
    const onOpenSecret = vi.fn();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const activity = vi.fn(async () => ({
      events: [
        event(),
        event({ action: 'grant.changed', targetId: null, detail: {} }),
        event({ at: yesterday, action: 'secret.copied' }),
      ],
      hasMore: false,
    }));
    setup(activity, { onOpenSecret });
    expect(await screen.findByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payments · Activity' })).toBeInTheDocument();
    const openers = screen.getAllByRole('button', { name: 'STRIPE_KEY' });
    await user.click(openers[0]!);
    expect(onOpenSecret).toHaveBeenCalledWith(IDS.secret, IDS.prod);
  });

  it('filters by kind and environment', async () => {
    const user = userEvent.setup();
    const activity = vi.fn(async () => ({
      events: [
        event({ action: 'secret.viewed', environmentId: IDS.prod }),
        event({ action: 'secret.created', environmentId: IDS.dev }),
        event({ action: 'grant.changed', environmentId: IDS.dev, targetId: null }),
      ],
      hasMore: false,
    }));
    setup(activity);
    await screen.findByText('Today');
    expect(document.querySelectorAll('.activity-row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Changes' }));
    expect(document.querySelectorAll('.activity-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Access' }));
    expect(document.querySelectorAll('.activity-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Used and shared' }));
    expect(document.querySelectorAll('.activity-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'All' }));
    const envs = screen.getByRole('group', { name: 'Environment' });
    await user.click(envs.querySelectorAll('button')[0]!);
    expect(document.querySelectorAll('.activity-row')).toHaveLength(2);
    await user.click(envs.querySelectorAll('button')[0]!);
    expect(document.querySelectorAll('.activity-row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Changes' }));
    await user.click(envs.querySelectorAll('button')[1]!);
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument();
  });

  it('shows an empty log', async () => {
    setup(vi.fn(async () => ({ events: [], hasMore: false })));
    expect(await screen.findByText(/Nothing has happened here yet/)).toBeInTheDocument();
  });

  it('loads older activity', async () => {
    const user = userEvent.setup();
    const activity = vi
      .fn()
      .mockResolvedValueOnce({ events: [event({ seq: 50 })], hasMore: true })
      .mockResolvedValueOnce({
        events: [event({ seq: 40, action: 'secret.copied' })],
        hasMore: false,
      });
    setup(activity);
    await user.click(await screen.findByRole('button', { name: 'Show older activity' }));
    await waitFor(() => expect(document.querySelectorAll('.activity-row')).toHaveLength(2));
    expect(activity).toHaveBeenLastCalledWith(IDS.project, { before: 50 });
    expect(screen.queryByRole('button', { name: 'Show older activity' })).toBeNull();
  });

  it('refreshes', async () => {
    const user = userEvent.setup();
    const activity = vi.fn(async () => ({ events: [], hasMore: false }));
    setup(activity);
    await screen.findByText(/Nothing has happened/);
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(activity).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['forbidden', new ForbiddenError('x'), /Only managers can see the activity log/],
    ['403', new ApiError(403), /Only managers can see the activity log/],
    ['404', new ApiError(404), /no longer available/],
    ['other', new Error('kaput'), /kaput/],
    ['unknown', 'weird', /could not load/],
  ])('handles a %s failure', async (_n, error, text) => {
    setup(vi.fn().mockRejectedValue(error));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows a failure while loading older activity', async () => {
    const user = userEvent.setup();
    const activity = vi
      .fn()
      .mockResolvedValueOnce({ events: [event()], hasMore: true })
      .mockRejectedValueOnce(new Error('page failed'));
    setup(activity);
    await user.click(await screen.findByRole('button', { name: 'Show older activity' }));
    expect(await screen.findByText('page failed')).toBeInTheDocument();
  });

  it('says when the project is gone', () => {
    setup(
      vi.fn(async () => ({ events: [], hasMore: false })),
      { projectId: 'nope' },
    );
    expect(screen.getByText('This project is no longer available.')).toBeInTheDocument();
  });
});

describe('groupByDay', () => {
  it('labels today, yesterday and older dates, with the year when it differs', () => {
    const now = new Date('2026-06-15T12:00:00');
    const at = (s: string) => event({ at: new Date(s).toISOString() });
    const groups = groupByDay(
      [
        at('2026-06-15T09:00:00'),
        at('2026-06-15T08:00:00'),
        at('2026-06-14T09:00:00'),
        at('2026-05-01T09:00:00'),
        at('2025-05-01T09:00:00'),
      ],
      now,
    );
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]!.events).toHaveLength(2);
    expect(groups[2]!.label).not.toMatch(/2026/);
    expect(groups[3]!.label).toMatch(/2025/);
  });
});

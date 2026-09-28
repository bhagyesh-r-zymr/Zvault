import type { ActivityEvent, ReportedEvent } from '@zvault/shared';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../agents/api.js';
import { ActivityReporter, agentEvents, describeEvent, resolveRef } from './activity.js';
import type { Environment, Project, ProjectSecret } from './model.js';
import { groupByDay } from './ProjectActivity.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [PROJECT, DEV, PROD, SECRET, FOLDER, NESTED, RIYA] = [1, 2, 3, 4, 5, 6, 7].map(id);

const env = (eid: string, name: string, slug: string): Environment => ({
  id: eid,
  revision: 1,
  name,
  slug,
  short: name.slice(0, 4),
  kind: 'custom',
  color: '#000',
  position: 0,
  inheritsFrom: null,
  locked: false,
});

const project: Project = {
  id: PROJECT!,
  slug: 'web',
  name: 'Web',
  owner: true,
  tile: { bg: '#000', fg: '#fff' },
  environments: [env(DEV!, 'Development', 'dev'), env(PROD!, 'Production', 'prod')],
  folders: [{ id: FOLDER!, revision: 1, name: 'Payments', slug: 'payments' }],
};

const secret = (sid: string, key: string, folder: Project['folders'][number] | null) =>
  ({
    id: sid,
    projectId: PROJECT!,
    revision: 1,
    name: key,
    key,
    folder,
    tags: [],
    values: {},
  }) satisfies ProjectSecret;

const secrets = [
  secret(SECRET!, 'DATABASE_URL', null),
  secret(NESTED!, 'STRIPE_KEY', project.folders[0]!),
];

const event = (e: Partial<ActivityEvent> & Pick<ActivityEvent, 'action'>): ActivityEvent => ({
  seq: 1,
  at: '2026-09-28T10:00:00.000Z',
  actor: { type: 'account', id: RIYA!, name: 'riya@acme.dev' },
  environmentId: PROD!,
  targetId: SECRET!,
  detail: {},
  ...e,
});

const ctx = { project, secrets, meEmail: 'me@acme.dev' };

describe('ActivityReporter', () => {
  function reporter() {
    const sent: { projectId: string; events: ReportedEvent[] }[] = [];
    let now = 0;
    let scheduled: (() => void) | null = null;
    const r = new ActivityReporter(
      {
        reportActivity: (projectId, events) => {
          sent.push({ projectId, events });
          return Promise.resolve();
        },
      },
      () => now,
      (fn) => {
        scheduled = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );
    return {
      r,
      sent,
      advance: (ms: number) => (now += ms),
      scheduled: () => scheduled,
    };
  }

  it('batches events per project and collapses quick repeats of a view', async () => {
    const t = reporter();
    t.r.viewed(PROJECT!, SECRET!, DEV!);
    t.r.viewed(PROJECT!, SECRET!, DEV!);
    t.r.copied(PROJECT!, SECRET!, DEV!);
    t.r.shared(PROJECT!, SECRET!, DEV!, 'link');
    t.r.shared(PROJECT!, SECRET!, DEV!, 'link');
    expect(t.scheduled()).not.toBeNull();
    await t.r.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.events.map((e) => e.action)).toEqual([
      'secret.viewed',
      'secret.copied',
      'secret.shared',
      'secret.shared',
    ]);

    t.advance(61_000);
    t.r.viewed(PROJECT!, SECRET!, DEV!);
    await t.r.flush();
    expect(t.sent[1]!.events).toEqual([
      { action: 'secret.viewed', secretId: SECRET, environmentId: DEV },
    ]);
  });

  it('never throws when reporting fails', async () => {
    const r = new ActivityReporter({ reportActivity: () => Promise.reject(new Error('offline')) });
    r.viewed(PROJECT!, SECRET!, DEV!);
    await expect(r.flush()).resolves.toBeUndefined();
  });
});

describe('agent events', () => {
  const entry = (e: Partial<ActivityEntry>): ActivityEntry => ({
    at: 1,
    agentId: 'a1',
    agentName: 'Claude Code',
    outcome: 'allowed',
    refs: [],
    purpose: { kind: 'run', command: ['npm', 'start', '--token=abc'], cwd: '/tmp' },
    reason: null,
    verifiedBy: null,
    peerPid: null,
    ...e,
  });

  it('resolves zv:// paths, with and without a folder', () => {
    expect(resolveRef('zv://web/prod/DATABASE_URL', [project], secrets)).toEqual({
      projectId: PROJECT,
      environmentId: PROD,
      secretId: SECRET,
    });
    expect(resolveRef('zv://web/dev/payments/STRIPE_KEY', [project], secrets)?.secretId).toBe(
      NESTED,
    );
    expect(resolveRef('zv://web/dev/STRIPE_KEY', [project], secrets)).toBeNull();
    expect(resolveRef('zv://other/dev/X', [project], secrets)).toBeNull();
  });

  it('reports uses and denials with the command kind only', () => {
    const out = agentEvents(
      [
        entry({ refs: ['zv://web/prod/DATABASE_URL'], verifiedBy: 'touchId', outcome: 'approved' }),
        entry({ refs: ['zv://web/dev/payments/STRIPE_KEY'], outcome: 'denied' }),
        entry({ outcome: 'paired' }),
        entry({ refs: ['zv://gone/dev/X'] }),
      ],
      [project],
      secrets,
    );
    expect(out).toEqual([
      {
        projectId: PROJECT,
        event: {
          action: 'agent.used',
          secretId: SECRET,
          environmentId: PROD,
          agent: { name: 'Claude Code', purpose: 'run', verifiedBy: 'touchId' },
        },
      },
      {
        projectId: PROJECT,
        event: {
          action: 'agent.denied',
          secretId: NESTED,
          environmentId: DEV,
          agent: { name: 'Claude Code', purpose: 'run', verifiedBy: null },
        },
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('abc');
  });
});

describe('describeEvent', () => {
  it('names secrets and environments from the decrypted project', () => {
    expect(describeEvent(event({ action: 'secret.copied' }), ctx)).toMatchObject({
      who: 'riya@acme.dev',
      what: 'copied',
      subject: 'DATABASE_URL',
      where: 'in Production',
      kind: 'use',
    });
  });

  it('says You for the signed-in account and handles removed things', () => {
    const mine = event({
      action: 'secret.deleted',
      actor: { type: 'account', id: RIYA!, name: 'ME@acme.dev' },
      targetId: id(99),
    });
    expect(describeEvent(mine, ctx)).toMatchObject({
      who: 'You',
      subject: 'a deleted secret',
      tone: 'negative',
    });
    const gone = event({
      action: 'secret.viewed',
      actor: { type: 'account', id: RIYA!, name: null },
    });
    expect(describeEvent(gone, ctx).who).toBe('A removed member');
  });

  it('describes grants, approvals and agent use', () => {
    const principal = { type: 'account' as const, id: RIYA!, name: 'riya@acme.dev' };
    expect(
      describeEvent(event({ action: 'grant.changed', detail: { principal, level: 'edit' } }), ctx),
    ).toMatchObject({ what: 'gave', subject: 'riya@acme.dev', where: 'Edit in Production' });
    expect(
      describeEvent(event({ action: 'request.approved', detail: { principal, items: 2 } }), ctx),
    ).toMatchObject({ subject: 'riya@acme.dev’s request', where: 'for 2 secrets in Production' });
    expect(
      describeEvent(
        event({
          action: 'agent.used',
          detail: { agent: { name: 'Claude Code', purpose: 'run', verifiedBy: 'touchId' } },
        }),
        ctx,
      ),
    ).toMatchObject({
      what: 'let Claude Code use',
      where: 'in Production for zv run, approved with Touch ID',
    });
  });
});

describe('groupByDay', () => {
  it('labels today and yesterday, newest first', () => {
    const now = new Date(2026, 8, 28, 12);
    const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
    const days = groupByDay(
      [
        event({ action: 'secret.viewed', at: at(28, 11) }),
        event({ action: 'secret.viewed', at: at(28, 9) }),
        event({ action: 'secret.viewed', at: at(27, 20) }),
        event({ action: 'secret.viewed', at: at(20, 8) }),
      ],
      now,
    );
    expect(days.map((d) => [d.label.split(',')[0], d.events.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [expect.any(String), 1],
    ]);
  });
});

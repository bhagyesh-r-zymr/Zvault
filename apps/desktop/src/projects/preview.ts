import type { EnvironmentKind } from '@zvault/shared';
import type { Project } from './model.js';

/**
 * Sample team for the Access screen. Team accounts and roles are being built
 * separately; until they land, the matrix shows these made-up groups next to
 * the real environments, and changes stay on this Mac.
 */

export type AccessLevel = 'manage' | 'edit' | 'use' | 'approval' | 'none';

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  manage: 'Manage',
  edit: 'Edit',
  use: 'Use',
  approval: 'Needs approval',
  none: 'No access',
};

export interface AccessEntry {
  id: string;
  name: string;
  kind: 'group' | 'person' | 'agent';
  detail: string;
  levels: Record<string, AccessLevel>;
  /** Extra words shown after the level, e.g. "asks each time". */
  note?: string;
}

type Sample = Omit<AccessEntry, 'levels'> & { levels: Record<EnvironmentKind, AccessLevel> };

const SAMPLE_TEAM: Sample[] = [
  {
    id: 'backend',
    name: 'Backend team',
    kind: 'group',
    detail: 'Group · 5 teammates',
    levels: { development: 'edit', staging: 'edit', production: 'approval', custom: 'edit' },
  },
  {
    id: 'qa',
    name: 'QA',
    kind: 'group',
    detail: 'Group · 3 teammates',
    levels: { development: 'use', staging: 'use', production: 'none', custom: 'edit' },
  },
  {
    id: 'contractor',
    name: 'Riya (contractor)',
    kind: 'person',
    detail: 'This project only · until Oct 31',
    levels: { development: 'use', staging: 'none', production: 'none', custom: 'none' },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'agent',
    detail: 'Agent on this Mac',
    note: 'asks each time',
    levels: { development: 'use', staging: 'use', production: 'none', custom: 'none' },
  },
];

/** You (from your real key grants), then the sample team. */
export function accessFor(project: Project): AccessEntry[] {
  const you: AccessEntry = {
    id: 'me',
    name: 'You',
    kind: 'person',
    detail: project.owner ? 'Owner' : 'Member',
    levels: Object.fromEntries(
      project.environments.map((e) => [
        e.id,
        e.locked ? 'none' : project.owner ? 'manage' : 'edit',
      ]),
    ),
  };
  return [
    you,
    ...SAMPLE_TEAM.map((s) => ({
      ...s,
      levels: Object.fromEntries(project.environments.map((e) => [e.id, s.levels[e.kind]])),
    })),
  ];
}

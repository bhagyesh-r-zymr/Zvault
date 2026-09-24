import { describe, expect, it } from 'vitest';
import { allLevels, effectiveLevel, type GrantFacts, type OrgFacts } from './levels.js';

const now = new Date('2026-10-01T00:00:00Z');
const org: OrgFacts = {
  activeMembers: new Set(['ana', 'ben', 'riya']),
  groupsOf: new Map([
    ['ana', ['managers', 'backend']],
    ['ben', ['backend', 'qa']],
  ]),
  agents: new Set(['claude']),
};
const g = (
  principalType: GrantFacts['principalType'],
  principalId: string,
  level: GrantFacts['level'],
  expiresAt: Date | null = null,
): GrantFacts => ({ principalType, principalId, level, expiresAt });

describe('effectiveLevel', () => {
  it('takes the strongest level among a member’s groups', () => {
    const grants = [g('group', 'backend', 'edit'), g('group', 'qa', 'use')];
    expect(effectiveLevel({ type: 'account', id: 'ben' }, grants, org, now)).toBe('edit');
  });

  it('lets a direct grant override groups, including blocking', () => {
    const grants = [g('group', 'managers', 'manage'), g('account', 'ana', 'none')];
    expect(effectiveLevel({ type: 'account', id: 'ana' }, grants, org, now)).toBe('none');
  });

  it('ignores expired grants', () => {
    const grants = [g('account', 'riya', 'use', new Date('2026-09-30T23:59:59Z'))];
    expect(effectiveLevel({ type: 'account', id: 'riya' }, grants, org, now)).toBe('none');
    const later = [g('account', 'riya', 'use', new Date('2026-10-31T00:00:00Z'))];
    expect(effectiveLevel({ type: 'account', id: 'riya' }, later, org, now)).toBe('use');
  });

  it('falls back to groups once a direct grant expires', () => {
    const grants = [
      g('account', 'ben', 'manage', new Date('2026-09-01T00:00:00Z')),
      g('group', 'qa', 'use'),
    ];
    expect(effectiveLevel({ type: 'account', id: 'ben' }, grants, org, now)).toBe('use');
  });

  it('gives nothing to invited members, strangers, or unknown agents', () => {
    const grants = [g('account', 'zed', 'manage'), g('agent', 'ghost', 'use')];
    expect(effectiveLevel({ type: 'account', id: 'zed' }, grants, org, now)).toBe('none');
    expect(effectiveLevel({ type: 'agent', id: 'ghost' }, grants, org, now)).toBe('none');
  });

  it('gives agents only their direct grants', () => {
    const grants = [g('agent', 'claude', 'needs_approval')];
    expect(effectiveLevel({ type: 'agent', id: 'claude' }, grants, org, now)).toBe(
      'needs_approval',
    );
  });
});

describe('allLevels', () => {
  it('covers every active member and agent', () => {
    const levels = allLevels([g('group', 'backend', 'use')], org, now);
    expect(Object.fromEntries(levels)).toEqual({
      'account:ana': 'use',
      'account:ben': 'use',
      'account:riya': 'none',
      'agent:claude': 'none',
    });
  });
});

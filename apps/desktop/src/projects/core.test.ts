import { describe, expect, it } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { projectsCore, teamKeysCore } from './core.js';

describe('projectsCore', () => {
  it('maps each method onto its Rust command', async () => {
    const calls = mockCore({
      project_create: 'created',
      project_open: 'opened',
      project_seal: 'sealed',
      environment_open: 'envopen',
      environment_seal: 'envseal',
      entry_seal: 'entryseal',
      entry_open: 'entryopen',
      secret_value_seal: 'vseal',
      secret_value_open: 'vopen',
    });
    const blob = {} as never;
    const meta = {} as never;
    expect(await projectsCore.createProject(meta, [])).toBe('created');
    expect(await projectsCore.openProject({ id: 'p' } as never)).toBe('opened');
    expect(await projectsCore.sealProject('p', meta)).toBe('sealed');
    expect(await projectsCore.openEnvironment('p', { id: 'e' } as never)).toBe('envopen');
    expect(await projectsCore.sealEnvironment('p', null, meta)).toBe('envseal');
    expect(await projectsCore.sealEntry('p', 'secret', null, meta)).toBe('entryseal');
    expect(await projectsCore.openEntry('p', 'folder', 'f', blob)).toBe('entryopen');
    expect(await projectsCore.sealValue('p', 's', 'e', 'v')).toBe('vseal');
    expect(await projectsCore.openValue('p', 's', 'e', blob)).toBe('vopen');
    expect(calls).toHaveBeenCalledWith('project_open', { project: { id: 'p' }, memberWrap: null });
    expect(calls).toHaveBeenCalledWith('secret_value_seal', {
      projectId: 'p',
      secretId: 's',
      environmentId: 'e',
      value: 'v',
    });
  });
});

describe('teamKeysCore', () => {
  it('maps each method onto its Rust command', async () => {
    mockCore({
      project_key_wrap: 1,
      environment_key_wrap: 2,
      environment_rotate: 3,
      environment_rotate_commit: true,
      access_release_seal: 5,
      access_release_open: [{ item: 'i', value: 'v' }],
    });
    expect(await teamKeysCore.wrapProjectKey('p', [])).toBe(1);
    expect(await teamKeysCore.wrapEnvironmentKey('p', 'e', 1, [])).toBe(2);
    expect(await teamKeysCore.rotateEnvironment('p', 'e', 1, [], [])).toBe(3);
    expect(await teamKeysCore.commitRotation('p', 'e')).toBe(true);
    expect(await teamKeysCore.sealRelease('p', 'r', 'pk', [])).toBe(5);
    expect(await teamKeysCore.openRelease('r', {} as never)).toEqual([{ item: 'i', value: 'v' }]);
  });
});

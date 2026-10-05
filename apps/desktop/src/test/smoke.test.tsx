import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { core } from '../core.js';
import { mockCore } from './tauri.js';

describe('test helpers', () => {
  it('answers invoke through the mocked IPC', async () => {
    const calls = mockCore({ core_info: { cryptoVersion: 1, aead: 'x', kdf: 'y' } });
    expect(await core.info()).toMatchObject({ aead: 'x' });
    expect(calls).toHaveBeenCalledWith('core_info', {});
    render(<p>hi</p>);
    expect(screen.getByText('hi')).toBeInTheDocument();
  });
});

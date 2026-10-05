import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUpdates } from './store.js';

describe('useUpdates', () => {
  it('exposes the shared state', () => {
    const { result } = renderHook(() => useUpdates());
    expect(result.current).toMatchObject({ check: null, installing: false });
  });
});

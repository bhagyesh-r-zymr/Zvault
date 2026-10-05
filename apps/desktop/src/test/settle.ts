import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts before the global teardown clears the Tauri mocks, and lets the
 * async `unlisten` calls components make on unmount run while the mocks exist.
 */
export function settleOnUnmount() {
  afterEach(async () => {
    cleanup();
    await new Promise((r) => setTimeout(r, 0));
  });
}

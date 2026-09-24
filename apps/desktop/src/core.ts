import { invoke } from '@tauri-apps/api/core';

/**
 * Typed bridge to the Rust core. All key material stays in Rust; the UI only
 * receives values it has to display.
 */
export interface CoreInfo {
  cryptoVersion: number;
  aead: string;
  kdf: string;
}

export const core = {
  info: () => invoke<CoreInfo>('core_info'),
};

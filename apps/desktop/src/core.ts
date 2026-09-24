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

  /** Whether sign-up left a new Secret Key waiting to be saved to a kit. */
  emergencyKitPending: () => invoke<boolean>('emergency_kit_pending'),
  /**
   * Renders the Emergency Kit PDF in Rust and saves it through a native save
   * dialog. The Secret Key never reaches the UI. Resolves to `false` if the
   * person cancelled the dialog.
   */
  saveEmergencyKit: (email: string) => invoke<boolean>('save_emergency_kit', { email }),
  /** Drops the staged Secret Key once the person confirms the kit is saved. */
  discardEmergencyKit: () => invoke<void>('discard_emergency_kit'),
};

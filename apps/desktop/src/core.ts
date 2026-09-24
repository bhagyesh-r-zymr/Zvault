import { invoke } from '@tauri-apps/api/core';
import type { EncryptedBlob, KdfParams } from '@zvault/shared';

/**
 * Typed bridge to the Rust core. All key material stays in Rust; the UI only
 * receives values it has to send to the server or display.
 */
export interface CoreInfo {
  cryptoVersion: number;
  aead: string;
  kdf: string;
}

export interface NewAccount {
  /** Shown once on the Emergency Kit. Never send it anywhere. */
  secretKey: string;
  secretKeyId: string;
  kdf: KdfParams;
  srpVerifier: string;
  encryptedKeyset: EncryptedBlob;
}

export interface LoginProof {
  srpA: string;
  srpM1: string;
}

export interface Unlocked {
  email: string;
}

export const core = {
  info: () => invoke<CoreInfo>('core_info'),
  createAccount: (email: string, password: string) =>
    invoke<NewAccount>('create_account', { email, password }),
  loginProve: (args: {
    email: string;
    password: string;
    secretKey: string;
    kdf: KdfParams;
    srpB: string;
  }) => invoke<LoginProof>('login_prove', args),
  /** Checks the server's SRP proof without finishing the login, before a 2FA code is sent. */
  loginVerifyServer: (srpM2: string) => invoke<void>('login_verify_server', { srpM2 }),
  loginFinish: (srpM2: string, encryptedKeyset: EncryptedBlob) =>
    invoke<Unlocked>('login_finish', { srpM2, encryptedKeyset }),
  lock: () => invoke<void>('lock'),
  unlocked: () => invoke<Unlocked | null>('unlocked'),

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

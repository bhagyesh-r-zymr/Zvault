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

/** The account whose Secret Key is saved in this Mac's Keychain. */
export interface RememberedAccount {
  email: string;
  /** The public first part of the key, safe to show. */
  secretKeyId: string;
}

/** What was read from an Emergency Kit PDF. The key itself stays in Rust. */
export interface ImportedKit {
  email: string | null;
  secretKeyId: string;
}

/** A password change, ready to upload with its proof of the current password. */
export interface PasswordChange {
  srpA: string;
  srpM1: string;
  kdf: KdfParams;
  srpVerifier: string;
  encryptedKeyset: EncryptedBlob;
}

/** A new recovery code's sealed keyset copy and verifier, with a proof of the password. */
export interface RecoverySetup {
  srpA: string;
  srpM1: string;
  recoveryKeyset: EncryptedBlob;
  recoveryVerifier: string;
}

/** What a recovery uploads. The new Secret Key and recovery code stay in Rust. */
export interface RecoveredAccount {
  secretKeyId: string;
  kdf: KdfParams;
  srpVerifier: string;
  encryptedKeyset: EncryptedBlob;
  recoveryKeyset: EncryptedBlob;
  recoveryVerifier: string;
}

/** How a Secret Key the UI never sees is shown: `Z1-ABC123-•••••-…`. */
export const maskedSecretKey = (id: string) => `Z1-${id}${'-•••••'.repeat(5)}`;

export const core = {
  info: () => invoke<CoreInfo>('core_info'),
  createAccount: (email: string, password: string) =>
    invoke<NewAccount>('create_account', { email, password }),
  loginProve: (args: {
    email: string;
    password: string;
    /** Null uses the key from a picked Emergency Kit or saved on this Mac. */
    secretKey: string | null;
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

  /** The account whose Secret Key this Mac remembers, if any. */
  rememberedAccount: () => invoke<RememberedAccount | null>('remembered_account'),
  /**
   * Opens a file dialog for the Emergency Kit PDF and reads the Secret Key
   * from it in Rust. The next sign-in uses it and saves it to the Keychain.
   * Resolves to null if the person cancelled.
   */
  importEmergencyKit: () => invoke<ImportedKit | null>('import_emergency_kit'),
  clearEmergencyKitImport: () => invoke<void>('clear_emergency_kit_import'),
  /** Deletes the saved Secret Key from this Mac's Keychain. */
  forgetSecretKey: () => invoke<void>('forget_secret_key'),

  /**
   * Proves the current master password for a fresh login challenge and seals
   * the keyset under the new one. `kdf` and `srpB` come from `login/start`.
   */
  passwordChangeProve: (args: {
    currentPassword: string;
    newPassword: string;
    kdf: KdfParams;
    srpB: string;
  }) => invoke<PasswordChange>('password_change_prove', args),
  /** Checks the server's proof; from then on the lock screen takes the new password. */
  passwordChangeFinish: (srpM2: string) => invoke<void>('password_change_finish', { srpM2 }),
  recoverySetupProve: (args: { password: string; kdf: KdfParams; srpB: string }) =>
    invoke<RecoverySetup>('recovery_setup_prove', args),
  /** Checks the server's proof and returns the new recovery code, to show once. */
  recoverySetupFinish: (srpM2: string) => invoke<string>('recovery_setup_finish', { srpM2 }),
  /** Saves the Recovery Kit PDF through a native dialog. False if cancelled. */
  saveRecoveryKit: () => invoke<boolean>('save_recovery_kit'),
  discardRecoveryCode: () => invoke<void>('discard_recovery_code'),
  /** Reads a recovery code; returns the auth token the server checks. */
  recoverBegin: (email: string, recoveryCode: string) =>
    invoke<string>('recover_begin', { email, recoveryCode }),
  /** Opens the released keyset copy and makes new keys for the new master password. */
  recoverReset: (newPassword: string, recoveryKeyset: EncryptedBlob) =>
    invoke<RecoveredAccount>('recover_reset', { newPassword, recoveryKeyset }),
  /** After the server accepted the reset: unlocks and returns the new recovery code. */
  recoverFinish: () => invoke<{ email: string; recoveryCode: string }>('recover_finish'),
  recoverCancel: () => invoke<void>('recover_cancel'),
};

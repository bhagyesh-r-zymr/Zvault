import { invoke } from '@tauri-apps/api/core';
import type { EncryptedBlob } from '@zvault/shared';

/**
 * Typed bridge to the vault commands in the Rust core. Keys never leave Rust:
 * these calls turn ciphertext records into what the UI shows, and back.
 */

export interface VaultCipher {
  id: string;
  encryptedKey: EncryptedBlob;
  encryptedMeta: EncryptedBlob;
}

export interface ItemCipher {
  id: string;
  encryptedKey: EncryptedBlob;
  encryptedData: EncryptedBlob;
}

export interface VaultSummary {
  id: string;
  name: string;
}

export interface ItemFields {
  title: string;
  username: string;
  password: string;
  urls: string[];
  notes: string;
  /** One-time password setup as an `otpauth://totp/` URI, or ''. */
  totp: string;
  /** The item's passkey. Its private key never leaves Rust. */
  passkey?: PasskeyFields;
}

/**
 * A passkey as the Rust core shows it. To create one, send only `rpId` and
 * `userName`; to import one, also send `credentialId`, `privateKey` and
 * optionally `userHandle`. An existing passkey is kept while its
 * `credentialId` comes back unchanged.
 */
export interface PasskeyFields {
  /** The website's domain, such as `github.com`. */
  rpId: string;
  userName: string;
  userHandle?: string;
  credentialId?: string;
  /** Base64url SubjectPublicKeyInfo. Output only. */
  publicKey?: string;
  /** Unix seconds. Output only. */
  createdAt?: number;
  /** Import only; never returned. */
  privateKey?: string;
}

export interface ItemSummary {
  title: string;
  username: string;
  url: string | null;
  hasTotp: boolean;
  hasPasskey: boolean;
}

/** A one-time password as computed in Rust. */
export interface OtpCode {
  code: string;
  period: number;
  /** Seconds until the next code. */
  remaining: number;
}

export interface VaultCore {
  createVault(name: string): Promise<{ record: VaultCipher; summary: VaultSummary }>;
  openVault(vault: VaultCipher): Promise<VaultSummary>;
  sealItem(vaultId: string, existing: ItemCipher | null, fields: ItemFields): Promise<ItemCipher>;
  openItem(vaultId: string, item: ItemCipher): Promise<ItemFields>;
  summarizeItem(vaultId: string, item: ItemCipher): Promise<ItemSummary>;
  /** The item's current one-time password, or null if it has none. */
  totpCode(vaultId: string, item: ItemCipher): Promise<OtpCode | null>;
  /** Signs a test WebAuthn challenge with the item's passkey and verifies it. */
  testPasskey(vaultId: string, item: ItemCipher): Promise<void>;
  /** The item as a `SharedItemPayload` JSON string, passkey included. */
  sharePayload(vaultId: string, item: ItemCipher): Promise<string>;
  lock(): Promise<void>;
}

export const vaultCore: VaultCore = {
  createVault: (name) => invoke('vault_create', { name }),
  openVault: (vault) => invoke('vault_open', { vault }),
  sealItem: (vaultId, existing, fields) => invoke('item_seal', { vaultId, existing, fields }),
  openItem: (vaultId, item) => invoke('item_open', { vaultId, item }),
  summarizeItem: (vaultId, item) => invoke('item_summary', { vaultId, item }),
  totpCode: (vaultId, item) => invoke('item_totp_code', { vaultId, item }),
  testPasskey: (vaultId, item) => invoke('item_passkey_test', { vaultId, item }),
  sharePayload: (vaultId, item) => invoke('item_share_payload', { vaultId, item }),
  lock: () => invoke('vault_lock'),
};

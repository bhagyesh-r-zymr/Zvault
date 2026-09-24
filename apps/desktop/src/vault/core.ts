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
}

export interface ItemSummary {
  title: string;
  username: string;
  url: string | null;
}

export interface VaultCore {
  createVault(name: string): Promise<{ record: VaultCipher; summary: VaultSummary }>;
  openVault(vault: VaultCipher): Promise<VaultSummary>;
  sealItem(vaultId: string, existing: ItemCipher | null, fields: ItemFields): Promise<ItemCipher>;
  openItem(vaultId: string, item: ItemCipher): Promise<ItemFields>;
  summarizeItem(vaultId: string, item: ItemCipher): Promise<ItemSummary>;
  lock(): Promise<void>;
}

export const vaultCore: VaultCore = {
  createVault: (name) => invoke('vault_create', { name }),
  openVault: (vault) => invoke('vault_open', { vault }),
  sealItem: (vaultId, existing, fields) => invoke('item_seal', { vaultId, existing, fields }),
  openItem: (vaultId, item) => invoke('item_open', { vaultId, item }),
  summarizeItem: (vaultId, item) => invoke('item_summary', { vaultId, item }),
  lock: () => invoke('vault_lock'),
};

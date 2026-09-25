import { invoke } from '@tauri-apps/api/core';
import type { EncryptedBlob, IncomingUserShare, SharedItemPayload } from '@zvault/shared';

/** Rust-side sharing commands. Keys are generated and used in Rust only. */

export interface NewShareLink {
  id: string;
  verifier: string;
  blob: EncryptedBlob;
  /** Holds the link key in its fragment: show it, never send it to the API. */
  url: string;
}

export interface SharingIdentity {
  publicKey: string;
  fingerprint: string;
}

export interface NewUserShare {
  id: string;
  senderPublicKey: string;
  ephemeralPublicKey: string;
  blob: EncryptedBlob;
}

export const sharingCore = {
  createLink: (item: SharedItemPayload, shareOrigin: string) =>
    invoke<NewShareLink>('share_link_create', { payload: JSON.stringify(item), shareOrigin }),
  identity: () => invoke<SharingIdentity>('sharing_identity'),
  fingerprint: (publicKey: string) => invoke<string>('sharing_fingerprint', { publicKey }),
  sealTo: (recipientPublicKey: string, item: SharedItemPayload) =>
    invoke<NewUserShare>('share_seal_to', { recipientPublicKey, payload: JSON.stringify(item) }),
  /** Opens a draft in the user's own mail app, so the link never passes through Zvault. */
  composeEmail: (to: string[], subject: string, body: string) =>
    invoke<void>('share_compose_email', { to, subject, body }),
  open: async (share: IncomingUserShare): Promise<string> =>
    invoke<string>('share_open', {
      share: {
        id: share.id,
        senderPublicKey: share.sender.publicKey,
        ephemeralPublicKey: share.ephemeralPublicKey,
        blob: share.blob,
      },
    }),
};

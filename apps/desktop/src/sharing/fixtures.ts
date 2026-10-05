import { SharingPublicKey, ShareId, type EncryptedBlob } from '@zvault/shared';

/** Valid 16-byte share id and 32-byte key / verifier in base64url. */
export const ID = ShareId.parse('AAAAAAAAAAAAAAAAAAAAAA');
export const ID2 = ShareId.parse('CCCCCCCCCCCCCCCCCCCCCC');
export const ID3 = ShareId.parse('DDDDDDDDDDDDDDDDDDDDDD');
export const ID4 = ShareId.parse('EEEEEEEEEEEEEEEEEEEEEE');
export const KEY = SharingPublicKey.parse('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
export const OTHER_KEY = SharingPublicKey.parse('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');

export function blob(kid: string): EncryptedBlob {
  return {
    v: 1,
    alg: 'xchacha20poly1305',
    kid,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ct: 'AAAA',
  } as EncryptedBlob;
}

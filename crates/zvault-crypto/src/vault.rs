//! Vault and item encryption.
//!
//! ```text
//! account key ──wraps──► vault key ──wraps──► item key ──seals──► item data
//!                                  └─seals──► vault metadata (name)
//! ```
//!
//! Every item has its own random key so a single item can later be shared
//! without exposing the rest of the vault. Every ciphertext is bound by its
//! associated data to the vault and item it belongs to, so the server cannot
//! move, swap or relabel records without decryption failing.

use zeroize::Zeroizing;

use crate::{Error, KEY_LEN, Result, Sealed, SymmetricKey, open, seal};

/// Plaintext is padded to a multiple of this many bytes so ciphertext length
/// reveals only a coarse size bucket, not e.g. the length of a password.
pub const PAD_BLOCK: usize = 256;
/// Largest item plaintext accepted, before padding.
pub const MAX_PLAINTEXT_LEN: usize = 64 * 1024;
const LEN_PREFIX: usize = 4;

/// Associated data for each kind of ciphertext. Ids are the client-generated
/// UUIDs the server stores the records under.
pub mod aad {
    pub fn vault_key(vault_id: &str) -> Vec<u8> {
        format!("zvault/v1/vault-key|{vault_id}").into_bytes()
    }

    pub fn vault_meta(vault_id: &str) -> Vec<u8> {
        format!("zvault/v1/vault-meta|{vault_id}").into_bytes()
    }

    pub fn item_key(vault_id: &str, item_id: &str) -> Vec<u8> {
        format!("zvault/v1/item-key|{vault_id}|{item_id}").into_bytes()
    }

    pub fn item_data(vault_id: &str, item_id: &str) -> Vec<u8> {
        format!("zvault/v1/item-data|{vault_id}|{item_id}").into_bytes()
    }
}

/// Encrypts `key` under `wrapping`.
pub fn wrap_key(wrapping: &SymmetricKey, key: &SymmetricKey, aad: &[u8]) -> Result<Sealed> {
    seal(wrapping, key.as_bytes(), aad)
}

/// Decrypts a key sealed by [`wrap_key`].
pub fn unwrap_key(wrapping: &SymmetricKey, sealed: &Sealed, aad: &[u8]) -> Result<SymmetricKey> {
    let bytes = Zeroizing::new(open(wrapping, sealed, aad)?);
    let bytes: [u8; KEY_LEN] = bytes.as_slice().try_into().map_err(|_| Error::Decrypt)?;
    Ok(SymmetricKey::from_bytes(bytes))
}

/// Pads `plaintext` to a [`PAD_BLOCK`] boundary and seals it.
pub fn seal_padded(key: &SymmetricKey, plaintext: &[u8], aad: &[u8]) -> Result<Sealed> {
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(Error::Encrypt);
    }
    let len = u32::try_from(plaintext.len()).map_err(|_| Error::Encrypt)?;
    let padded_len = (LEN_PREFIX + plaintext.len()).div_ceil(PAD_BLOCK) * PAD_BLOCK;
    let mut padded = Zeroizing::new(Vec::with_capacity(padded_len));
    padded.extend_from_slice(&len.to_be_bytes());
    padded.extend_from_slice(plaintext);
    padded.resize(padded_len, 0);
    seal(key, &padded, aad)
}

/// Opens a value sealed by [`seal_padded`] and strips the padding.
pub fn open_padded(key: &SymmetricKey, sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut padded = Zeroizing::new(open(key, sealed, aad)?);
    let prefix: [u8; LEN_PREFIX] = padded
        .get(..LEN_PREFIX)
        .and_then(|p| p.try_into().ok())
        .ok_or(Error::Decrypt)?;
    let len = usize::try_from(u32::from_be_bytes(prefix)).map_err(|_| Error::Decrypt)?;
    if len > padded.len() - LEN_PREFIX {
        return Err(Error::Decrypt);
    }
    padded.copy_within(LEN_PREFIX..LEN_PREFIX + len, 0);
    padded.truncate(len);
    Ok(padded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TAG_LEN;

    const V: &str = "8d1b6f1e-0000-4000-8000-000000000001";
    const I: &str = "8d1b6f1e-0000-4000-8000-0000000000aa";

    #[test]
    fn wraps_and_unwraps_keys() {
        let account = SymmetricKey::generate().unwrap();
        let vault = SymmetricKey::generate().unwrap();
        let sealed = wrap_key(&account, &vault, &aad::vault_key(V)).unwrap();
        let back = unwrap_key(&account, &sealed, &aad::vault_key(V)).unwrap();
        assert_eq!(back.as_bytes(), vault.as_bytes());
    }

    #[test]
    fn item_key_is_bound_to_its_vault_and_item() {
        let vault = SymmetricKey::generate().unwrap();
        let item = SymmetricKey::generate().unwrap();
        let sealed = wrap_key(&vault, &item, &aad::item_key(V, I)).unwrap();
        assert!(unwrap_key(&vault, &sealed, &aad::item_key(V, "other")).is_err());
        assert!(unwrap_key(&vault, &sealed, &aad::item_key("other", I)).is_err());
        assert!(unwrap_key(&vault, &sealed, &aad::item_data(V, I)).is_err());
    }

    #[test]
    fn padding_hides_exact_length() {
        let key = SymmetricKey::generate().unwrap();
        let short = seal_padded(&key, b"pw", b"").unwrap();
        let longer = seal_padded(&key, &[b'x'; 200], b"").unwrap();
        assert_eq!(short.ciphertext.len(), PAD_BLOCK + TAG_LEN);
        assert_eq!(short.ciphertext.len(), longer.ciphertext.len());

        let over = seal_padded(&key, &[b'x'; PAD_BLOCK], b"").unwrap();
        assert_eq!(over.ciphertext.len(), 2 * PAD_BLOCK + TAG_LEN);
    }

    #[test]
    fn padded_round_trip() {
        let key = SymmetricKey::generate().unwrap();
        for len in [0, 1, 251, 252, 253, 1000] {
            let data = vec![0xab; len];
            let sealed = seal_padded(&key, &data, &aad::item_data(V, I)).unwrap();
            let back = open_padded(&key, &sealed, &aad::item_data(V, I)).unwrap();
            assert_eq!(back.as_slice(), data.as_slice(), "len {len}");
        }
    }

    #[test]
    fn rejects_oversized_plaintext() {
        let key = SymmetricKey::generate().unwrap();
        let big = vec![0; MAX_PLAINTEXT_LEN + 1];
        assert_eq!(seal_padded(&key, &big, b""), Err(Error::Encrypt));
    }

    #[test]
    fn rejects_a_corrupt_length_prefix() {
        let key = SymmetricKey::generate().unwrap();
        let mut bogus = vec![0u8; PAD_BLOCK];
        bogus[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        let sealed = seal(&key, &bogus, b"").unwrap();
        assert!(open_padded(&key, &sealed, b"").is_err());
    }
}

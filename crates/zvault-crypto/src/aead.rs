use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::{Error, Result, SymmetricKey, random};

/// XChaCha20-Poly1305 nonce length. 192 bits makes random nonces safe.
pub const NONCE_LEN: usize = 24;
/// Poly1305 tag length, appended to the ciphertext.
pub const TAG_LEN: usize = 16;

/// A ciphertext and the random nonce it was sealed with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

/// Encrypts `plaintext`, binding it to `aad` (e.g. the item and vault ids) so
/// the server cannot swap ciphertexts between records.
pub fn seal(key: &SymmetricKey, plaintext: &[u8], aad: &[u8]) -> Result<Sealed> {
    let nonce: [u8; NONCE_LEN] = random::array()?;
    let ciphertext = cipher(key)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Encrypt)?;
    Ok(Sealed { nonce, ciphertext })
}

/// Decrypts and authenticates a [`Sealed`] value. Fails if the key, nonce,
/// ciphertext or `aad` differ in any way from what was sealed.
pub fn open(key: &SymmetricKey, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>> {
    cipher(key)
        .decrypt(
            XNonce::from_slice(&sealed.nonce),
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .map_err(|_| Error::Decrypt)
}

fn cipher(key: &SymmetricKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.as_bytes().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let key = SymmetricKey::generate().unwrap();
        let sealed = seal(&key, b"hunter2", b"item:1").unwrap();
        assert_eq!(sealed.ciphertext.len(), 7 + TAG_LEN);
        assert_eq!(open(&key, &sealed, b"item:1").unwrap(), b"hunter2");
    }

    #[test]
    fn uses_a_fresh_nonce_each_time() {
        let key = SymmetricKey::generate().unwrap();
        let a = seal(&key, b"same", b"").unwrap();
        let b = seal(&key, b"same", b"").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn rejects_wrong_aad() {
        let key = SymmetricKey::generate().unwrap();
        let sealed = seal(&key, b"secret", b"item:1").unwrap();
        assert_eq!(open(&key, &sealed, b"item:2"), Err(Error::Decrypt));
    }

    #[test]
    fn rejects_wrong_key() {
        let sealed = seal(&SymmetricKey::generate().unwrap(), b"secret", b"").unwrap();
        let other = SymmetricKey::generate().unwrap();
        assert_eq!(open(&other, &sealed, b""), Err(Error::Decrypt));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let key = SymmetricKey::generate().unwrap();
        let mut sealed = seal(&key, b"secret", b"").unwrap();
        sealed.ciphertext[0] ^= 1;
        assert_eq!(open(&key, &sealed, b""), Err(Error::Decrypt));
    }
}

//! Client-side cryptography for Zvault.
//!
//! Everything here runs on the user's device. The server only ever sees the
//! outputs that are safe to store: ciphertext, nonces, KDF parameters and the
//! public id prefix of the Secret Key.
//!
//! Key hierarchy (two-secret key derivation, modelled on 1Password's 2SKD):
//!
//! ```text
//! master password ──Argon2id──┐
//!                             XOR ──► account unlock key ──unwraps──► keyset ──► vault keys
//! Secret Key ──────HKDF───────┘
//! ```
//!
//! Neither secret alone is enough: a stolen server database needs both the
//! master password and the 128-bit Secret Key, which never leaves the device
//! except on the printed Emergency Kit.

mod aead;
mod error;
mod kdf;
mod key;
mod random;
mod secret_key;

pub use aead::{NONCE_LEN, Sealed, TAG_LEN, open, seal};
pub use error::{Error, Result};
pub use kdf::{KdfParams, SALT_LEN, derive_unlock_key};
pub use key::{KEY_LEN, SymmetricKey};
pub use secret_key::SecretKey;

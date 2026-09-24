//! Client-side cryptography for Zvault.
//!
//! Everything here runs on the user's device. The server only ever sees the
//! outputs that are safe to store: ciphertext, nonces, KDF parameters and the
//! public id prefix of the Secret Key.
//!
//! Key hierarchy (two-secret key derivation, modelled on 1Password's 2SKD):
//!
//! ```text
//! master password ──Argon2id──┐                ┌─► unlock key ──unwraps──► keyset ──► vault keys
//!                             XOR ──► HKDF ──┤
//! Secret Key ──────HKDF───────┘                └─► SRP x ──► verifier g^x (stored by the server)
//! ```
//!
//! Login is SRP-6a (see [`srp`]): the server checks a proof of `x` against
//! the verifier and never receives the password, the Secret Key or `x`.
//!
//! Neither secret alone is enough: a stolen server database needs both the
//! master password and the 128-bit Secret Key, which never leaves the device
//! except on the printed Emergency Kit.
//!
//! Vault and item encryption (per-item keys, padding, record binding) lives in
//! [`vault`]; projects, environments and secrets in [`project`].

mod aead;
mod error;
mod kdf;
mod key;
mod keyset;
pub mod project;
mod random;
mod secret_key;
mod share;
pub mod srp;
pub mod vault;

pub use aead::{NONCE_LEN, Sealed, TAG_LEN, open, seal};
pub use error::{Error, Result};
pub use kdf::{AccountKeys, KdfParams, SALT_LEN, derive_account_keys, normalize_account_id};
pub use key::{KEY_LEN, SymmetricKey};
pub use keyset::{KEYSET_KID, open_keyset, seal_keyset};
pub use secret_key::SecretKey;
pub use share::{
    BoxedShare, LinkShare, PUBLIC_KEY_LEN, SHARE_ID_LEN, SharingKeyPair, fingerprint, open_from,
    seal_to,
};

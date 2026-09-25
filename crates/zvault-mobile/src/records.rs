//! Wire records from the API, in the shapes of `@zvault/shared`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Deserialize;
use zvault_crypto::{NONCE_LEN, PUBLIC_KEY_LEN, Sealed};

use crate::keyring::Error;

/// Must match `CRYPTO_VERSION` in `@zvault/shared`.
pub const CRYPTO_VERSION: u32 = 1;
const ALG: &str = "xchacha20poly1305";
/// `kid` of a key wrapped by the account key.
pub const ACCOUNT_KID: &str = "account";
/// `kid` of a key wrapped to a member (`MEMBER_KEY_WRAP_KID`).
pub const MEMBER_KEY_WRAP_KID: &str = "member-key-wrap";

/// `EncryptedBlob`.
#[derive(Debug, Clone, Deserialize)]
pub struct Blob {
    pub v: u32,
    pub alg: String,
    pub kid: String,
    pub nonce: String,
    pub ct: String,
}

impl Blob {
    /// Decodes the blob, checking it was sealed by the key the caller expects.
    pub fn sealed(&self, expected_kid: &str) -> Result<Sealed, Error> {
        if self.v != CRYPTO_VERSION || self.alg != ALG || self.kid != expected_kid {
            return Err(Error::InvalidRecord);
        }
        let nonce: [u8; NONCE_LEN] = decode_array(&self.nonce)?;
        let ciphertext = B64.decode(&self.ct).map_err(|_| Error::InvalidRecord)?;
        Ok(Sealed { nonce, ciphertext })
    }
}

/// `VaultRecord`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_meta: Blob,
}

/// A live `ItemRecord`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecord {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_data: Blob,
}

/// `ProjectRecord`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_meta: Blob,
}

/// A live `EnvironmentEntry`. `encrypted_key` is absent without access to values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentRecord {
    pub id: String,
    pub encrypted_meta: Blob,
    #[serde(default)]
    pub encrypted_key: Option<Blob>,
}

/// `StoredMemberWrap`: one of this account's wraps of a shared key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberWrap {
    pub recipient_public_key: String,
    pub wrapper_public_key: String,
    pub ephemeral_public_key: String,
    pub blob: Blob,
    /// Environment keys only.
    #[serde(default)]
    pub key_version: Option<u32>,
}

pub fn decode_array<const N: usize>(s: &str) -> Result<[u8; N], Error> {
    B64.decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(Error::InvalidRecord)
}

pub fn decode_key(s: &str) -> Result<[u8; PUBLIC_KEY_LEN], Error> {
    decode_array(s)
}

pub fn parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, Error> {
    serde_json::from_str(json).map_err(|_| Error::InvalidRecord)
}

//! Touch ID quick unlock.
//!
//! After a master-password unlock the account unlock key is stored in the
//! macOS data-protection Keychain under an access control that requires the
//! currently enrolled fingerprints (`kSecAccessControlBiometryCurrentSet`) and
//! a device passcode (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`). The
//! item never syncs to iCloud, and macOS deletes it if fingerprints are added
//! or removed or the passcode is turned off.
//!
//! Quick unlock expires: the stored record carries the time the master password
//! was last entered, and after [`MAX_AGE`] the record is deleted and the
//! master password is required again.

// Only the macOS Keychain backend uses the record format and most errors.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use zeroize::Zeroizing;
use zvault_crypto::{KEY_LEN, SymmetricKey};

/// How long Touch ID may keep unlocking without the master password.
pub const MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const RECORD_VERSION: u8 = 1;
const RECORD_LEN: usize = 1 + 8 + KEY_LEN;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BiometricError {
    #[error("Touch ID is not available on this device")]
    Unavailable,
    #[error("Touch ID unlock is not set up")]
    NotEnrolled,
    #[error("Touch ID unlock has expired; enter your master password")]
    Expired,
    #[error("Touch ID was cancelled or not recognised")]
    Cancelled,
    #[error("this build is not signed with the Keychain entitlement Touch ID needs")]
    MissingEntitlement,
    #[error("Keychain error {code}")]
    Keychain { code: i32 },
}

/// What is stored in the Keychain.
pub struct Record {
    pub key: SymmetricKey,
    pub password_verified_at: SystemTime,
}

/// Serialises a record without copying `key` out of its zeroizing wrapper.
pub fn encode_record(
    key: &SymmetricKey,
    password_verified_at: SystemTime,
) -> Zeroizing<[u8; RECORD_LEN]> {
    let mut out = Zeroizing::new([0u8; RECORD_LEN]);
    out[0] = RECORD_VERSION;
    out[1..9].copy_from_slice(&unix_secs(password_verified_at).to_be_bytes());
    out[9..].copy_from_slice(key.as_bytes());
    out
}

/// Expired dates, and dates in the future (clock tampering), are not honoured.
pub fn is_fresh(password_verified_at: SystemTime, now: SystemTime) -> bool {
    now.duration_since(password_verified_at)
        .is_ok_and(|age| age < MAX_AGE)
}

impl Record {
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != RECORD_LEN || bytes[0] != RECORD_VERSION {
            return None;
        }
        let secs = u64::from_be_bytes(bytes[1..9].try_into().ok()?);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&bytes[9..]);
        Some(Self {
            key: SymmetricKey::from_bytes(*key),
            password_verified_at: UNIX_EPOCH + Duration::from_secs(secs),
        })
    }
}

fn unix_secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub use imp::{available, delete, load, store};

#[cfg(target_os = "macos")]
mod imp {
    pub use crate::platform::macos::keychain::{available, delete, load, store};
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::time::SystemTime;

    use zvault_crypto::SymmetricKey;

    use super::{BiometricError, Record};

    pub fn available() -> bool {
        false
    }

    pub fn store(
        _account_id: &str,
        _key: &SymmetricKey,
        _password_verified_at: SystemTime,
    ) -> Result<(), BiometricError> {
        Err(BiometricError::Unavailable)
    }

    pub fn load(_account_id: &str) -> Result<Record, BiometricError> {
        Err(BiometricError::Unavailable)
    }

    pub fn delete(_account_id: &str) -> Result<(), BiometricError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let at = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        let bytes = encode_record(&SymmetricKey::from_bytes([9; KEY_LEN]), at);
        let back = Record::decode(bytes.as_ref()).unwrap();
        assert_eq!(back.key.as_bytes(), &[9; KEY_LEN]);
        assert_eq!(back.password_verified_at, at);
    }

    #[test]
    fn rejects_malformed_records() {
        let bytes = encode_record(&SymmetricKey::from_bytes([9; KEY_LEN]), UNIX_EPOCH);
        assert!(Record::decode(&bytes[..RECORD_LEN - 1]).is_none());
        let mut wrong_version = *bytes;
        wrong_version[0] = 2;
        assert!(Record::decode(&wrong_version).is_none());
    }

    #[test]
    fn expires_after_max_age_and_rejects_future_dates() {
        let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        assert!(is_fresh(now - MAX_AGE + Duration::from_secs(1), now));
        assert!(!is_fresh(now - MAX_AGE, now));
        assert!(!is_fresh(now + Duration::from_secs(60), now));
    }
}

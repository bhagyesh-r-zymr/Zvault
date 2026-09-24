use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::{Error, KEY_LEN, Result, SecretKey, SymmetricKey};

pub const SALT_LEN: usize = 16;

/// Argon2id parameters, stored on the server next to the account and returned
/// to the client before unlock. Mirrors `KdfParams` in `@zvault/shared`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: [u8; SALT_LEN],
}

impl KdfParams {
    /// Floor enforced everywhere; matches `KDF_MINIMUMS` in `@zvault/shared`.
    pub const MIN_MEMORY_KIB: u32 = 64 * 1024;
    pub const MIN_ITERATIONS: u32 = 3;
    /// Upper bounds, so a hostile server can't make the client exhaust memory or CPU.
    pub const MAX_MEMORY_KIB: u32 = 4 * 1024 * 1024;
    pub const MAX_ITERATIONS: u32 = 64;

    /// Defaults for new accounts; matches `KDF_DEFAULTS` in `@zvault/shared`.
    pub fn new_default(salt: [u8; SALT_LEN]) -> Self {
        Self {
            memory_kib: 256 * 1024,
            iterations: 3,
            parallelism: 4,
            salt,
        }
    }

    /// Defaults with a fresh random salt, for a new account.
    pub fn generate_default() -> Result<Self> {
        Ok(Self::new_default(crate::random::array()?))
    }

    fn validate(&self) -> Result<Params> {
        if !(Self::MIN_MEMORY_KIB..=Self::MAX_MEMORY_KIB).contains(&self.memory_kib)
            || !(Self::MIN_ITERATIONS..=Self::MAX_ITERATIONS).contains(&self.iterations)
            || !(1..=16).contains(&self.parallelism)
        {
            return Err(Error::InvalidKdfParams);
        }
        Params::new(
            self.memory_kib,
            self.iterations,
            self.parallelism,
            Some(KEY_LEN),
        )
        .map_err(|_| Error::InvalidKdfParams)
    }
}

/// The two keys derived from the master password and Secret Key.
///
/// They come from one Argon2id run and are separated with HKDF, so knowing
/// one reveals nothing about the other.
pub struct AccountKeys {
    /// Unwraps the account keyset. Never leaves the device.
    pub unlock_key: SymmetricKey,
    /// The SRP private value `x`. Only `g^x` (the verifier) reaches the server.
    pub srp_x: SymmetricKey,
}

/// Derives the account keys from both secrets.
///
/// `account_id` is the user's stable identifier (e.g. the normalized email).
/// It is mixed into both halves so identical passwords and Secret Keys on two
/// accounts never produce the same key.
pub fn derive_account_keys(
    master_password: &str,
    secret_key: &SecretKey,
    account_id: &str,
    params: &KdfParams,
) -> Result<AccountKeys> {
    let argon_params = params.validate()?;
    let account_id = normalize_account_id(account_id);

    // Normalize so the same password typed on different keyboards/OSes matches.
    let password: Zeroizing<String> = Zeroizing::new(master_password.nfkd().collect());

    // Bind the stored random salt to the account so it can't be reused elsewhere.
    let mut salt = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(account_id.as_bytes()), &params.salt)
        .expand(b"zvault/v1/password-salt", salt.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");

    let mut from_password = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params)
        .hash_password_into(password.as_bytes(), salt.as_ref(), from_password.as_mut())
        .map_err(|_| Error::InvalidKdfParams)?;

    let from_secret_key = secret_key.derive(account_id.as_bytes());

    let mut master = Zeroizing::new([0u8; KEY_LEN]);
    for (out, (a, b)) in master
        .iter_mut()
        .zip(from_password.iter().zip(from_secret_key.iter()))
    {
        *out = a ^ b;
    }

    let hk = Hkdf::<Sha256>::new(None, master.as_ref());
    let expand = |info: &[u8]| {
        let mut out = [0u8; KEY_LEN];
        hk.expand(info, &mut out)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        SymmetricKey::from_bytes(out)
    };
    Ok(AccountKeys {
        unlock_key: expand(b"zvault/v1/unlock-key"),
        srp_x: expand(b"zvault/v1/srp-x"),
    })
}

/// The canonical form of an account id (email): trimmed and lowercased.
/// Mirrors `normalizeEmail` in `@zvault/shared`.
pub fn normalize_account_id(account_id: &str) -> String {
    account_id.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SK: &str = "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345";
    const SK2: &str = "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12346";

    /// Minimum-strength params keep the tests fast.
    fn params() -> KdfParams {
        KdfParams {
            memory_kib: KdfParams::MIN_MEMORY_KIB,
            iterations: KdfParams::MIN_ITERATIONS,
            parallelism: 1,
            salt: [7; SALT_LEN],
        }
    }

    fn derive(password: &str, sk: &str, account: &str) -> [u8; KEY_LEN] {
        let sk = SecretKey::parse(sk).unwrap();
        *derive_account_keys(password, &sk, account, &params())
            .unwrap()
            .unlock_key
            .as_bytes()
    }

    #[test]
    fn is_deterministic_and_normalizes_inputs() {
        let a = derive("correct horse", SK, "Alice@Example.com");
        let b = derive("correct horse", SK, "  alice@example.com ");
        assert_eq!(a, b);
        // "é" precomposed vs. e + combining acute accent.
        assert_eq!(derive("caf\u{e9}", SK, "a"), derive("cafe\u{301}", SK, "a"));
    }

    #[test]
    fn every_input_changes_the_key() {
        let base = derive("correct horse", SK, "alice@example.com");
        assert_ne!(base, derive("correct horsf", SK, "alice@example.com"));
        assert_ne!(base, derive("correct horse", SK2, "alice@example.com"));
        assert_ne!(base, derive("correct horse", SK, "bob@example.com"));

        let sk = SecretKey::parse(SK).unwrap();
        let other_salt = KdfParams {
            salt: [8; SALT_LEN],
            ..params()
        };
        let k =
            derive_account_keys("correct horse", &sk, "alice@example.com", &other_salt).unwrap();
        assert_ne!(&base, k.unlock_key.as_bytes());
    }

    #[test]
    fn unlock_key_and_srp_secret_differ() {
        let sk = SecretKey::parse(SK).unwrap();
        let keys = derive_account_keys("correct horse", &sk, "a", &params()).unwrap();
        assert_ne!(keys.unlock_key.as_bytes(), keys.srp_x.as_bytes());
    }

    #[test]
    fn rejects_weak_params() {
        let sk = SecretKey::parse(SK).unwrap();
        let weak = KdfParams {
            memory_kib: 1024,
            ..params()
        };
        assert!(matches!(
            derive_account_keys("pw", &sk, "a", &weak),
            Err(Error::InvalidKdfParams)
        ));
        let weak = KdfParams {
            iterations: 1,
            ..params()
        };
        assert!(matches!(
            derive_account_keys("pw", &sk, "a", &weak),
            Err(Error::InvalidKdfParams)
        ));
    }
}

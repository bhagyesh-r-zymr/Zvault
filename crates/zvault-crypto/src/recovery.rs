//! Account recovery codes.
//!
//! A recovery code is a second, independent way to open the account keyset,
//! for someone who forgot their master password or lost their Secret Key. It
//! is generated on the device and shown once; the server never sees it.
//!
//! ```text
//! recovery code ──HKDF──┬─► wrap key ──seals──► keyset copy (stored by the server)
//!                       └─► auth token ──SHA-256──► verifier (stored by the server)
//! ```
//!
//! During recovery the device sends the auth token, which the server checks
//! against the verifier before it releases the sealed copy. The wrap key stays
//! on the device, so the server can check a code without being able to open
//! the keyset. The code carries 150 random bits, so no slow KDF is needed: the
//! verifier can't be brute-forced.

use core::fmt;

use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::secret_key::{ALPHABET, fill_alphabet};
use crate::{Error, KEY_LEN, Result, Sealed, SymmetricKey, kdf::normalize_account_id, open, seal};

const VERSION: &str = "R1";
const GROUPS: usize = 6;
const GROUP_CHARS: usize = 5;
const CHARS: usize = GROUPS * GROUP_CHARS;

/// Key id carried on the recovery copy's `EncryptedBlob`.
pub const RECOVERY_KID: &str = "recovery";

/// A recovery code: `R1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`, 30 Crockford
/// base32 characters (150 bits), all of them secret.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct RecoveryCode([u8; CHARS]);

/// What a recovery code derives for one account.
pub struct RecoveryKeys {
    /// Seals the recovery copy of the keyset. Never leaves the device.
    pub wrap_key: SymmetricKey,
    /// Proves the code to the server during recovery.
    pub auth_token: SymmetricKey,
}

impl RecoveryKeys {
    /// What the server stores to check `auth_token` later: its SHA-256.
    pub fn verifier(&self) -> [u8; 32] {
        Sha256::digest(self.auth_token.as_bytes()).into()
    }
}

impl RecoveryCode {
    pub fn generate() -> Result<Self> {
        let mut chars = [0u8; CHARS];
        fill_alphabet(&mut chars)?;
        Ok(Self(chars))
    }

    /// Parses a code as a person might type it: case, spaces and dashes are
    /// ignored, and the look-alikes O, I and L are read as 0, 1 and 1.
    pub fn parse(input: &str) -> Result<Self> {
        let chars: Zeroizing<Vec<u8>> = Zeroizing::new(
            input
                .bytes()
                .filter(|b| !matches!(b, b'-' | b' ' | b'\t' | b'\n' | b'\r'))
                .map(|b| match b.to_ascii_uppercase() {
                    b'O' => b'0',
                    b'I' | b'L' => b'1',
                    other => other,
                })
                .collect(),
        );
        let rest = chars
            .strip_prefix(VERSION.as_bytes())
            .ok_or(Error::InvalidRecoveryCode)?;
        if rest.len() != CHARS || !rest.iter().all(|b| ALPHABET.contains(b)) {
            return Err(Error::InvalidRecoveryCode);
        }
        let mut code = Self([0; CHARS]);
        code.0.copy_from_slice(rest);
        Ok(code)
    }

    /// The code for display. Treat the result as secret.
    pub fn to_display_string(&self) -> Zeroizing<String> {
        let mut out = String::with_capacity(VERSION.len() + CHARS + GROUPS);
        out.push_str(VERSION);
        for group in self.0.chunks(GROUP_CHARS) {
            out.push('-');
            out.push_str(core::str::from_utf8(group).expect("alphabet is ASCII"));
        }
        Zeroizing::new(out)
    }

    /// Derives the wrap key and auth token for `account_id`. Binding the
    /// account in means one code never unlocks another account's copy.
    pub fn keys(&self, account_id: &str) -> RecoveryKeys {
        let account_id = normalize_account_id(account_id);
        let hk = Hkdf::<Sha256>::new(Some(b"zvault/v1/recovery-code"), &self.0);
        let expand = |purpose: &str| {
            let mut out = [0u8; KEY_LEN];
            let info = format!("zvault/v1/recovery/{purpose}/{account_id}");
            hk.expand(info.as_bytes(), &mut out)
                .expect("32 bytes is a valid HKDF-SHA256 output length");
            SymmetricKey::from_bytes(out)
        };
        RecoveryKeys {
            wrap_key: expand("wrap"),
            auth_token: expand("auth"),
        }
    }
}

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecoveryCode").finish_non_exhaustive()
    }
}

/// Separate from the password-sealed keyset's AAD, so the server can't swap
/// one copy in for the other.
fn aad(account_id: &str) -> Vec<u8> {
    format!(
        "zvault/v1/recovery-keyset/{}",
        normalize_account_id(account_id)
    )
    .into_bytes()
}

/// Seals the recovery copy of the account keyset.
pub fn seal_recovery_keyset(
    keys: &RecoveryKeys,
    keyset: &SymmetricKey,
    account_id: &str,
) -> Result<Sealed> {
    seal(&keys.wrap_key, keyset.as_bytes(), &aad(account_id))
}

/// Opens the recovery copy. Fails on the wrong code or another account's copy.
pub fn open_recovery_keyset(
    keys: &RecoveryKeys,
    sealed: &Sealed,
    account_id: &str,
) -> Result<SymmetricKey> {
    let bytes = Zeroizing::new(open(&keys.wrap_key, sealed, &aad(account_id))?);
    let key: [u8; KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::Decrypt)?;
    Ok(SymmetricKey::from_bytes(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open_keyset, seal_keyset};

    const CODE: &str = "R1-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567";

    #[test]
    fn generated_codes_round_trip_through_display() {
        let code = RecoveryCode::generate().unwrap();
        let shown = code.to_display_string();
        assert_eq!(shown.len(), 2 + 6 * 6);
        assert!(shown.starts_with("R1-"));
        assert_eq!(RecoveryCode::parse(&shown).unwrap().0, code.0);
        assert_ne!(RecoveryCode::generate().unwrap().0, code.0);
    }

    #[test]
    fn parse_is_forgiving_about_formatting() {
        let a = RecoveryCode::parse(CODE).unwrap();
        let b = RecoveryCode::parse("r1 abcde fghjk mnpqr stvwx yzo12 34567\n").unwrap();
        assert_eq!(a.0, b.0);
    }

    #[test]
    fn rejects_bad_input() {
        for bad in [
            "",
            "R1",
            "Z1-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567",
            "R1-ABCDE-FGHJK-MNPQR-STVWX-YZ012-3456",
            "R1-ABCDE-FGHJK-MNPQR-STVWX-YZ012-3456U",
        ] {
            assert!(RecoveryCode::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_are_separate_and_bound_to_the_account() {
        let code = RecoveryCode::parse(CODE).unwrap();
        let a = code.keys("Alice@Example.com");
        assert_eq!(
            a.wrap_key.as_bytes(),
            code.keys(" alice@example.com").wrap_key.as_bytes()
        );
        assert_ne!(a.wrap_key.as_bytes(), a.auth_token.as_bytes());
        let b = code.keys("bob@example.com");
        assert_ne!(a.wrap_key.as_bytes(), b.wrap_key.as_bytes());
        assert_ne!(a.verifier(), b.verifier());
        assert_ne!(&a.verifier(), a.auth_token.as_bytes());
    }

    #[test]
    fn recovery_copy_opens_only_with_the_right_code_and_account() {
        let keyset = SymmetricKey::generate().unwrap();
        let code = RecoveryCode::generate().unwrap();
        let keys = code.keys("alice@example.com");
        let sealed = seal_recovery_keyset(&keys, &keyset, "alice@example.com").unwrap();

        let opened = open_recovery_keyset(&keys, &sealed, "alice@example.com").unwrap();
        assert_eq!(opened.as_bytes(), keyset.as_bytes());

        let other = RecoveryCode::generate().unwrap().keys("alice@example.com");
        assert!(matches!(
            open_recovery_keyset(&other, &sealed, "alice@example.com"),
            Err(Error::Decrypt)
        ));
        assert!(matches!(
            open_recovery_keyset(&keys, &sealed, "bob@example.com"),
            Err(Error::Decrypt)
        ));
    }

    #[test]
    fn copies_are_not_interchangeable_with_the_password_sealed_keyset() {
        let keyset = SymmetricKey::generate().unwrap();
        let keys = RecoveryCode::generate().unwrap().keys("a@b.c");
        let recovery = seal_recovery_keyset(&keys, &keyset, "a@b.c").unwrap();
        let normal = seal_keyset(&keys.wrap_key, &keyset, "a@b.c").unwrap();
        assert!(open_keyset(&keys.wrap_key, &recovery, "a@b.c").is_err());
        assert!(open_recovery_keyset(&keys, &normal, "a@b.c").is_err());
    }

    #[test]
    fn debug_does_not_leak_the_code() {
        let code = RecoveryCode::parse(CODE).unwrap();
        assert!(!format!("{code:?}").contains("ABCDE"));
    }
}

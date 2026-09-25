use core::fmt;

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{Error, KEY_LEN, Result, random};

/// Crockford base32: no I, L, O or U, so the printed kit is easy to retype.
pub(crate) const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERSION: &str = "Z1";
const ID_CHARS: usize = 6;
const SECRET_GROUPS: usize = 5;
const GROUP_CHARS: usize = 5;
const SECRET_CHARS: usize = SECRET_GROUPS * GROUP_CHARS;

/// The account Secret Key printed on the Emergency Kit.
///
/// Format: `Z1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. The six-character id is
/// public and lets the server tell keys apart; the remaining 25 characters
/// (125 bits) are secret and never leave the device.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecretKey {
    id: [u8; ID_CHARS],
    secret: [u8; SECRET_CHARS],
}

impl SecretKey {
    pub fn generate() -> Result<Self> {
        let mut id = [0u8; ID_CHARS];
        let mut secret = [0u8; SECRET_CHARS];
        fill_alphabet(&mut id)?;
        fill_alphabet(&mut secret)?;
        Ok(Self { id, secret })
    }

    /// Parses a Secret Key as a person might type it: case, spaces and dashes
    /// are ignored, and the look-alikes O, I and L are read as 0, 1 and 1.
    pub fn parse(input: &str) -> Result<Self> {
        let chars: Zeroizing<Vec<u8>> = Zeroizing::new(
            input
                .bytes()
                .filter(|b| !matches!(b, b'-' | b' ' | b'\t'))
                .map(|b| match b.to_ascii_uppercase() {
                    b'O' => b'0',
                    b'I' | b'L' => b'1',
                    other => other,
                })
                .collect(),
        );
        let rest = chars
            .strip_prefix(VERSION.as_bytes())
            .ok_or(Error::InvalidSecretKey)?;
        if rest.len() != ID_CHARS + SECRET_CHARS || !rest.iter().all(|b| ALPHABET.contains(b)) {
            return Err(Error::InvalidSecretKey);
        }
        let mut key = Self {
            id: [0; ID_CHARS],
            secret: [0; SECRET_CHARS],
        };
        key.id.copy_from_slice(&rest[..ID_CHARS]);
        key.secret.copy_from_slice(&rest[ID_CHARS..]);
        Ok(key)
    }

    /// The public id prefix. Safe to send to the server.
    pub fn id(&self) -> &str {
        core::str::from_utf8(&self.id).expect("alphabet is ASCII")
    }

    /// The full key for display on the Emergency Kit. Treat the result as secret.
    pub fn to_display_string(&self) -> Zeroizing<String> {
        let mut out =
            String::with_capacity(VERSION.len() + 1 + ID_CHARS + SECRET_CHARS + SECRET_GROUPS);
        out.push_str(VERSION);
        out.push('-');
        out.push_str(self.id());
        for group in self.secret.chunks(GROUP_CHARS) {
            out.push('-');
            out.push_str(core::str::from_utf8(group).expect("alphabet is ASCII"));
        }
        Zeroizing::new(out)
    }

    /// Expands the Secret Key into 256 bits of key material for the unlock key.
    pub(crate) fn derive(&self, account_id: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
        let mut info = Vec::with_capacity(32 + account_id.len());
        info.extend_from_slice(b"zvault/v1/secret-key/");
        info.extend_from_slice(account_id);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        Hkdf::<Sha256>::new(Some(&self.id), &self.secret)
            .expand(&info, out.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretKey")
            .field("id", &self.id())
            .finish_non_exhaustive()
    }
}

/// Fills `out` with uniformly random alphabet characters (32 divides 256, so
/// masking the low five bits has no modulo bias).
pub(crate) fn fill_alphabet(out: &mut [u8]) -> Result<()> {
    random::fill(out)?;
    for b in out.iter_mut() {
        *b = ALPHABET[usize::from(*b & 0x1f)];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_round_trip_through_display() {
        let key = SecretKey::generate().unwrap();
        let shown = key.to_display_string();
        assert_eq!(shown.len(), 2 + 1 + 6 + 5 * 6);
        let parsed = SecretKey::parse(&shown).unwrap();
        assert_eq!(parsed.id(), key.id());
        assert_eq!(parsed.secret, key.secret);
    }

    #[test]
    fn parse_is_forgiving_about_formatting() {
        let a = SecretKey::parse("Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345").unwrap();
        let b = SecretKey::parse("z1 abc123 defgh jkmnp qrstv wxyzo 12345").unwrap();
        assert_eq!(a.secret, b.secret);
    }

    #[test]
    fn rejects_bad_input() {
        for bad in [
            "",
            "Z1",
            "Z2-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345",
            "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-1234",
            "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-1234U",
        ] {
            assert!(SecretKey::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn debug_does_not_leak_the_secret() {
        let key = SecretKey::parse("Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345").unwrap();
        let dbg = format!("{key:?}");
        assert!(dbg.contains("ABC123"));
        assert!(!dbg.contains("DEFGH"));
    }
}

//! Reads the Secret Key back out of an Emergency Kit this crate rendered, so
//! a person can point the app at their kit instead of retyping the key.
//!
//! Only kits saved by Zvault are supported: their text sits in one
//! uncompressed content stream as PDF literal strings. A kit that was
//! re-saved or printed to PDF by another app is usually compressed, and
//! reading it returns `None`.

use zeroize::Zeroizing;
use zvault_crypto::SecretKey;

/// Kits are a few kilobytes; anything much bigger isn't one.
pub const MAX_KIT_BYTES: usize = 1024 * 1024;

/// What a kit says.
pub struct ReadKit {
    /// The account email printed on the kit, if it could be read.
    pub email: Option<String>,
    pub secret_key: SecretKey,
}

/// Finds the Secret Key (and the email, when present) in a kit's bytes.
pub fn read(pdf: &[u8]) -> Option<ReadKit> {
    if pdf.len() > MAX_KIT_BYTES || !pdf.starts_with(b"%PDF-") {
        return None;
    }
    let strings = literal_strings(pdf);
    let secret_key = strings
        .iter()
        .filter(|s| s.starts_with(b"Z1-"))
        .find_map(|s| SecretKey::parse(core::str::from_utf8(s).ok()?).ok())?;
    Some(ReadKit {
        email: email(&strings),
        secret_key,
    })
}

/// The email is printed under the EMAIL label, wrapped over several strings
/// when it is long, and followed by the SECRET KEY label.
fn email(strings: &[Zeroizing<Vec<u8>>]) -> Option<String> {
    let start = strings.iter().position(|s| s.as_slice() == b"EMAIL")? + 1;
    let mut email = String::new();
    for s in &strings[start..] {
        if s.as_slice() == b"SECRET KEY" {
            break;
        }
        email.push_str(core::str::from_utf8(s).ok()?);
    }
    let shaped = email.bytes().all(|b| b.is_ascii_graphic()) && email.contains('@');
    shaped.then_some(email)
}

/// Every `( ... ) Tj` string in the file, unescaped. Each buffer is wiped
/// when dropped, since one of them holds the Secret Key.
fn literal_strings(pdf: &[u8]) -> Vec<Zeroizing<Vec<u8>>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < pdf.len() {
        if pdf[i] != b'(' {
            i += 1;
            continue;
        }
        let mut s = Zeroizing::new(Vec::new());
        let mut depth = 1;
        i += 1;
        while i < pdf.len() {
            let b = pdf[i];
            i += 1;
            match b {
                b'\\' => {
                    let Some(&next) = pdf.get(i) else { break };
                    if (b'0'..=b'7').contains(&next) {
                        let digits = pdf[i..]
                            .iter()
                            .take(3)
                            .take_while(|d| (b'0'..=b'7').contains(d))
                            .count();
                        let value = pdf[i..i + digits]
                            .iter()
                            .fold(0u16, |v, d| v * 8 + u16::from(d - b'0'));
                        s.push(u8::try_from(value & 0xff).unwrap_or_default());
                        i += digits;
                    } else {
                        s.push(next);
                        i += 1;
                    }
                }
                b'(' => {
                    depth += 1;
                    s.push(b);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    s.push(b);
                }
                _ => s.push(b),
            }
        }
        out.push(s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Date, Kit};

    const KEY: &str = "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345";

    fn kit(email: &str) -> Zeroizing<Vec<u8>> {
        Kit {
            email,
            sign_in_url: "https://my.zvault.app",
            secret_key: &SecretKey::parse(KEY).unwrap(),
            created_on: Date::new(2026, 9, 24).unwrap(),
        }
        .render()
        .unwrap()
    }

    #[test]
    fn reads_back_what_it_rendered() {
        let read = read(&kit("ada@example.com")).unwrap();
        assert_eq!(&*read.secret_key.to_display_string(), KEY);
        assert_eq!(read.email.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn reads_wrapped_and_escaped_emails() {
        let long = format!("{}@example.com", "a".repeat(100));
        assert_eq!(read(&kit(&long)).unwrap().email, Some(long));
        let odd = "we(i)rd\\@example.com";
        assert_eq!(read(&kit(odd)).unwrap().email.as_deref(), Some(odd));
    }

    #[test]
    fn rejects_files_that_are_not_kits() {
        assert!(read(b"").is_none());
        assert!(read(b"not a pdf (Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345)").is_none());
        assert!(read(b"%PDF-1.7\n(Z1-NOT-A-KEY) Tj").is_none());
        let mut huge = kit("ada@example.com").to_vec();
        huge.resize(MAX_KIT_BYTES + 1, b' ');
        assert!(read(&huge).is_none());
    }
}

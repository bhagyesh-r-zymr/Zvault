//! One-time passwords kept inside vault items, like 1Password's "one-time
//! password" field. A site's 2FA secret is stored (encrypted, in the item) as
//! an `otpauth://totp/...` URI and the current code is computed here, on the
//! device. Nothing in this crate talks to the network.
//!
//! Accepted input: an `otpauth://totp/` URI (what a QR code holds), or a bare
//! base32 key as sites show under "can't scan the code?".

use std::fmt::Write as _;

use hmac::{Hmac, Mac};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Hash used for the HMAC. Almost every site uses SHA-1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Algorithm {
    #[default]
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    fn name(self) -> &'static str {
        match self {
            Self::Sha1 => "SHA1",
            Self::Sha256 => "SHA256",
            Self::Sha512 => "SHA512",
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OtpError {
    #[error("That isn't a valid one-time password setup key or otpauth:// link.")]
    Invalid,
    #[error("Only time-based (TOTP) codes are supported, not counter-based (HOTP) ones.")]
    Hotp,
    #[error("The setup key is too short to be secure.")]
    TooShort,
    #[error("Unsupported one-time password settings.")]
    Unsupported,
}

pub type Result<T> = core::result::Result<T, OtpError>;

/// Shortest secret accepted, in bytes (RFC 4226 requires at least 128 bits;
/// some sites use 80, so allow that).
const MIN_SECRET_BYTES: usize = 10;
const MAX_SECRET_BYTES: usize = 128;
const MAX_LABEL_CHARS: usize = 256;

/// A TOTP generator. The secret is wiped on drop.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct Totp {
    secret: Vec<u8>,
    #[zeroize(skip)]
    algorithm: Algorithm,
    digits: u32,
    period: u64,
    issuer: String,
    account: String,
}

impl std::fmt::Debug for Totp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Totp")
            .field("issuer", &self.issuer)
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

/// The code for one moment, and how long it stays valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub code: String,
    pub period: u64,
    /// Whole seconds until the next code (1..=period).
    pub remaining: u64,
}

impl Totp {
    /// Parses what a person scanned, pasted or typed.
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim();
        if input.len() > 4096 {
            return Err(OtpError::Invalid);
        }
        let lower = input.get(..10).map(str::to_ascii_lowercase);
        match lower.as_deref() {
            Some("otpauth://") => Self::from_uri(input),
            _ => Self::from_key(input, String::new(), String::new()),
        }
    }

    /// A bare base32 key with the usual settings (SHA-1, 6 digits, 30 s).
    fn from_key(key: &str, issuer: String, account: String) -> Result<Self> {
        let secret = base32_decode(key).ok_or(OtpError::Invalid)?;
        Self::new(secret, Algorithm::Sha1, 6, 30, issuer, account)
    }

    fn new(
        secret: Zeroizing<Vec<u8>>,
        algorithm: Algorithm,
        digits: u32,
        period: u64,
        issuer: String,
        account: String,
    ) -> Result<Self> {
        if secret.len() < MIN_SECRET_BYTES {
            return Err(OtpError::TooShort);
        }
        if secret.len() > MAX_SECRET_BYTES {
            return Err(OtpError::Invalid);
        }
        if !(6..=8).contains(&digits) || !(1..=300).contains(&period) {
            return Err(OtpError::Unsupported);
        }
        if issuer.chars().count() > MAX_LABEL_CHARS || account.chars().count() > MAX_LABEL_CHARS {
            return Err(OtpError::Invalid);
        }
        Ok(Self {
            secret: secret.to_vec(),
            algorithm,
            digits,
            period,
            issuer,
            account,
        })
    }

    /// Parses `otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=...`.
    fn from_uri(uri: &str) -> Result<Self> {
        let rest = &uri["otpauth://".len()..];
        let (kind, rest) = rest.split_once('/').ok_or(OtpError::Invalid)?;
        match kind.to_ascii_lowercase().as_str() {
            "totp" => {}
            "hotp" => return Err(OtpError::Hotp),
            _ => return Err(OtpError::Invalid),
        }
        let (label, query) = rest.split_once('?').unwrap_or((rest, ""));
        let label = percent_decode(label).ok_or(OtpError::Invalid)?;
        let (label_issuer, account) = match label.split_once(':') {
            Some((i, a)) => (i.trim().to_owned(), a.trim().to_owned()),
            None => (String::new(), label.trim().to_owned()),
        };

        let mut secret = None;
        let mut issuer = None;
        let mut algorithm = Algorithm::Sha1;
        let mut digits = 6;
        let mut period = 30;
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let v = Zeroizing::new(percent_decode(v).ok_or(OtpError::Invalid)?);
            match k.to_ascii_lowercase().as_str() {
                "secret" => secret = Some(base32_decode(&v).ok_or(OtpError::Invalid)?),
                "issuer" => issuer = Some(v.trim().to_owned()),
                "algorithm" => {
                    algorithm = match v.to_ascii_uppercase().as_str() {
                        "SHA1" => Algorithm::Sha1,
                        "SHA256" => Algorithm::Sha256,
                        "SHA512" => Algorithm::Sha512,
                        _ => return Err(OtpError::Unsupported),
                    }
                }
                "digits" => digits = v.parse().map_err(|_| OtpError::Unsupported)?,
                "period" => period = v.parse().map_err(|_| OtpError::Unsupported)?,
                _ => {}
            }
        }
        let secret = secret.ok_or(OtpError::Invalid)?;
        let issuer = issuer.filter(|i| !i.is_empty()).unwrap_or(label_issuer);
        Self::new(secret, algorithm, digits, period, issuer, account)
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn account(&self) -> &str {
        &self.account
    }

    pub fn digits(&self) -> u32 {
        self.digits
    }

    pub fn period(&self) -> u64 {
        self.period
    }

    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }

    /// The canonical URI stored in the item. Contains the secret.
    pub fn to_uri(&self) -> Zeroizing<String> {
        let mut label = String::new();
        if !self.issuer.is_empty() {
            label.push_str(&percent_encode(&self.issuer));
            label.push(':');
        }
        label.push_str(&percent_encode(&self.account));
        let secret = base32_encode(&self.secret);
        let mut uri = Zeroizing::new(format!("otpauth://totp/{label}?secret={}", *secret));
        if !self.issuer.is_empty() {
            let _ = write!(uri, "&issuer={}", percent_encode(&self.issuer));
        }
        if self.algorithm != Algorithm::Sha1 {
            let _ = write!(uri, "&algorithm={}", self.algorithm.name());
        }
        if self.digits != 6 {
            let _ = write!(uri, "&digits={}", self.digits);
        }
        if self.period != 30 {
            let _ = write!(uri, "&period={}", self.period);
        }
        uri
    }

    /// The code at `unix_secs` (RFC 6238).
    pub fn code_at(&self, unix_secs: u64) -> Code {
        let counter = unix_secs / self.period;
        let value = match self.algorithm {
            Algorithm::Sha1 => hotp::<Hmac<sha1::Sha1>>(&self.secret, counter),
            Algorithm::Sha256 => hotp::<Hmac<sha2::Sha256>>(&self.secret, counter),
            Algorithm::Sha512 => hotp::<Hmac<sha2::Sha512>>(&self.secret, counter),
        };
        let modulus = 10u32.pow(self.digits);
        Code {
            code: format!("{:0width$}", value % modulus, width = self.digits as usize),
            period: self.period,
            remaining: self.period - unix_secs % self.period,
        }
    }
}

/// RFC 4226 HOTP with dynamic truncation, before the modulus.
fn hotp<M: Mac + hmac::digest::KeyInit>(secret: &[u8], counter: u64) -> u32 {
    let mut mac = <M as Mac>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let bytes = [
        digest[offset],
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ];
    u32::from_be_bytes(bytes) & 0x7fff_ffff
}

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32, ignoring case, spaces, hyphens and `=` padding.
fn base32_decode(input: &str) -> Option<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(Vec::with_capacity(input.len() * 5 / 8));
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for c in input.bytes() {
        if matches!(c, b' ' | b'-' | b'=' | b'\t') {
            continue;
        }
        let c = c.to_ascii_uppercase();
        let value = BASE32.iter().position(|&b| b == c)? as u64;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    buffer.zeroize();
    Some(out)
}

fn base32_encode(bytes: &[u8]) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::with_capacity(bytes.len().div_ceil(5) * 8));
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buffer = (buffer << 8) | u64::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    buffer.zeroize();
    out
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'@') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri_for(secret: &[u8], algorithm: &str) -> String {
        format!(
            "otpauth://totp/Test:alice?secret={}&algorithm={algorithm}&digits=8",
            *base32_encode(secret)
        )
    }

    /// RFC 6238 appendix B test vectors.
    #[test]
    fn matches_rfc_6238_vectors() {
        let sha1 = b"12345678901234567890";
        let sha256 = b"12345678901234567890123456789012";
        let sha512 = b"1234567890123456789012345678901234567890123456789012345678901234";
        let cases: [(u64, &str, &str, &str); 6] = [
            (59, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ];
        let t1 = Totp::parse(&uri_for(sha1, "SHA1")).unwrap();
        let t256 = Totp::parse(&uri_for(sha256, "SHA256")).unwrap();
        let t512 = Totp::parse(&uri_for(sha512, "SHA512")).unwrap();
        for (time, c1, c256, c512) in cases {
            assert_eq!(t1.code_at(time).code, c1, "sha1 at {time}");
            assert_eq!(t256.code_at(time).code, c256, "sha256 at {time}");
            assert_eq!(t512.code_at(time).code, c512, "sha512 at {time}");
        }
    }

    #[test]
    fn reports_time_left() {
        let t = Totp::parse("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(t.code_at(60).remaining, 30);
        assert_eq!(t.code_at(89).remaining, 1);
        assert_eq!(t.code_at(89).code.len(), 6);
    }

    #[test]
    fn parses_a_typical_qr_code() {
        let t = Totp::parse(
            "otpauth://totp/Microsoft:alice%40contoso.com?secret=jbswy3dpehpk3pxp&issuer=Microsoft",
        )
        .unwrap();
        assert_eq!(t.issuer(), "Microsoft");
        assert_eq!(t.account(), "alice@contoso.com");
        assert_eq!(
            (t.digits(), t.period(), t.algorithm()),
            (6, 30, Algorithm::Sha1)
        );
        assert_eq!(
            t.to_uri().as_str(),
            "otpauth://totp/Microsoft:alice@contoso.com?secret=JBSWY3DPEHPK3PXP&issuer=Microsoft"
        );
    }

    #[test]
    fn takes_the_issuer_from_the_label_when_missing() {
        let t = Totp::parse("otpauth://totp/GitHub:bob?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!((t.issuer(), t.account()), ("GitHub", "bob"));
    }

    #[test]
    fn accepts_keys_typed_with_spaces_and_lowercase() {
        let a = Totp::parse("jbsw y3dp ehpk 3pxp").unwrap();
        let b = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(a.code_at(1_000), b.code_at(1_000));
        assert!(
            a.to_uri()
                .starts_with("otpauth://totp/?secret=JBSWY3DPEHPK3PXP")
        );
    }

    #[test]
    fn round_trips_through_its_uri() {
        let t = Totp::parse(
            "otpauth://totp/A%20B:c?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
        )
        .unwrap();
        assert_eq!(Totp::parse(&t.to_uri()).unwrap(), t);
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(Totp::parse("not a key!").unwrap_err(), OtpError::Invalid);
        assert_eq!(Totp::parse("JBSWY3DP").unwrap_err(), OtpError::TooShort);
        assert_eq!(
            Totp::parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1").unwrap_err(),
            OtpError::Hotp
        );
        assert_eq!(
            Totp::parse("otpauth://totp/x?issuer=y").unwrap_err(),
            OtpError::Invalid
        );
        assert_eq!(
            Totp::parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=10").unwrap_err(),
            OtpError::Unsupported
        );
        assert_eq!(
            Totp::parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0").unwrap_err(),
            OtpError::Unsupported
        );
        assert_eq!(
            Totp::parse("otpauth://totp/%zz?secret=JBSWY3DPEHPK3PXP").unwrap_err(),
            OtpError::Invalid
        );
    }

    #[test]
    fn base32_round_trips() {
        for len in 0..40 {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(*base32_decode(&base32_encode(&bytes)).unwrap(), bytes);
        }
    }

    #[test]
    fn debug_hides_the_secret() {
        let t = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        assert!(!format!("{t:?}").contains("JBSW"));
    }
}

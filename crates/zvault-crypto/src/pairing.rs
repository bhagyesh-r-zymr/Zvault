//! Signing a new phone in by scanning a QR code on a signed-in device.
//!
//! The signed-in device (the "Mac") makes a one-time [`PairingOffer`]: a fresh
//! X25519 key pair and a 256-bit pairing secret, shown as a QR code together
//! with the server's pairing id. The phone scans it and:
//!
//! 1. proves it saw the QR by sending the server the [`claim_token`], derived
//!    from the secret. The server stores only a hash of that token, so it can
//!    check a claim but cannot compute the secret;
//! 2. sends its own fresh public key, which the server relays to the Mac.
//!
//! Both screens then show a [`verification_code`] over the secret and both
//! public keys. The server never learns the secret, so it cannot pick a
//! public key that makes the codes match. When the person taps Allow, the
//! Mac seals the account keyset to the phone's key with [`seal_grant`], a
//! sender-authenticated box the phone opens with the Mac key from the QR.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::share::{open_box, seal_box};
use crate::{BoxedShare, Error, KEY_LEN, PUBLIC_KEY_LEN, Result, SharingKeyPair, random};

/// Pairing ids are UUIDs, bound into the grant as their 16 bytes.
pub const PAIRING_ID_LEN: usize = 16;
/// Digits in the code both screens show.
pub const CODE_DIGITS: usize = 6;

const URI_PREFIX: &str = "zvault://pair?";
const URI_VERSION: &str = "1";
const CLAIM_INFO: &[u8] = b"zvault/v1/pairing/claim";
const CODE_PREFIX: &[u8] = b"zvault/v1/pairing/code";
const BOX_INFO: &[u8] = b"zvault/v1/pairing-box";
const BOX_AAD_PREFIX: &[u8] = b"zvault/v1/pairing-box:";

/// What the QR code carries.
pub struct PairingOffer {
    /// API origin the phone should talk to, e.g. `https://vault.example.com`.
    pub api: String,
    /// The server's pairing id (a UUID string).
    pub id: String,
    /// The Mac's pairing public key.
    pub public_key: [u8; PUBLIC_KEY_LEN],
    pub secret: Zeroizing<[u8; KEY_LEN]>,
}

impl PairingOffer {
    pub fn to_uri(&self) -> String {
        format!(
            "{URI_PREFIX}v={URI_VERSION}&api={}&id={}&k={}&s={}",
            percent_encode(&self.api),
            self.id,
            B64.encode(self.public_key),
            B64.encode(*self.secret)
        )
    }

    /// Parses a scanned QR code. Anything that isn't a version 1 pairing
    /// code, or has a field of the wrong size, is rejected.
    pub fn parse(uri: &str) -> Option<Self> {
        let query = uri.trim().strip_prefix(URI_PREFIX)?;
        let (mut v, mut api, mut id, mut k, mut s) = (None, None, None, None, None);
        for pair in query.split('&') {
            let (name, value) = pair.split_once('=')?;
            let slot = match name {
                "v" => &mut v,
                "api" => &mut api,
                "id" => &mut id,
                "k" => &mut k,
                "s" => &mut s,
                _ => continue,
            };
            if slot.replace(value).is_some() {
                return None;
            }
        }
        if v? != URI_VERSION {
            return None;
        }
        let api = percent_decode(api?)?;
        if !(api.starts_with("https://") || api.starts_with("http://")) {
            return None;
        }
        let id = id?;
        uuid_bytes(id)?;
        let public_key = B64.decode(k?).ok()?.try_into().ok()?;
        let secret: [u8; KEY_LEN] = B64.decode(s?).ok()?.try_into().ok()?;
        Some(Self {
            api,
            id: id.to_owned(),
            public_key,
            secret: Zeroizing::new(secret),
        })
    }
}

/// A fresh pairing secret for a new offer.
pub fn generate_secret() -> Result<Zeroizing<[u8; KEY_LEN]>> {
    Ok(Zeroizing::new(random::array()?))
}

/// The token the phone presents to claim the pairing. The Mac registers it
/// when it creates the pairing; the server keeps only its hash.
pub fn claim_token(secret: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut out = [0u8; KEY_LEN];
    Hkdf::<Sha256>::new(None, secret)
        .expand(CLAIM_INFO, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// The six-digit code both screens show, e.g. `"472918"`.
pub fn verification_code(
    secret: &[u8; KEY_LEN],
    mac_public: &[u8; PUBLIC_KEY_LEN],
    phone_public: &[u8; PUBLIC_KEY_LEN],
) -> String {
    let digest = Sha256::new()
        .chain_update(CODE_PREFIX)
        .chain_update(secret)
        .chain_update(mac_public)
        .chain_update(phone_public)
        .finalize();
    let n = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
    format!(
        "{:0width$}",
        n % 10u64.pow(CODE_DIGITS as u32),
        width = CODE_DIGITS
    )
}

/// Seals the account grant from the Mac to the phone for this pairing.
pub fn seal_grant(
    mac: &SharingKeyPair,
    phone_public: &[u8; PUBLIC_KEY_LEN],
    pairing_id: &str,
    plaintext: &[u8],
) -> Result<BoxedShare> {
    seal_box(
        BOX_INFO,
        &box_aad(pairing_id)?,
        mac,
        phone_public,
        plaintext,
    )
}

/// Opens a grant. Fails unless the Mac whose key was in the QR sealed it to
/// this phone for exactly this pairing.
pub fn open_grant(
    phone: &SharingKeyPair,
    mac_public: &[u8; PUBLIC_KEY_LEN],
    pairing_id: &str,
    boxed: &BoxedShare,
) -> Result<Zeroizing<Vec<u8>>> {
    open_box(BOX_INFO, &box_aad(pairing_id)?, phone, mac_public, boxed).map(Zeroizing::new)
}

fn box_aad(pairing_id: &str) -> Result<Vec<u8>> {
    let id = uuid_bytes(pairing_id).ok_or(Error::Decrypt)?;
    Ok([BOX_AAD_PREFIX, &id].concat())
}

/// The 16 bytes of a lowercase hyphenated UUID; anything else is rejected so
/// one pairing has exactly one id string.
fn uuid_bytes(id: &str) -> Option<[u8; PAIRING_ID_LEN]> {
    let b = id.as_bytes();
    if b.len() != 36 || [8, 13, 18, 23].iter().any(|&i| b[i] != b'-') {
        return None;
    }
    let hex: Vec<u8> = b.iter().copied().filter(|&c| c != b'-').collect();
    if hex.len() != 32 || !hex.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut out = [0u8; PAIRING_ID_LEN];
    for (i, pair) in hex.chunks(2).enumerate() {
        let s = std::str::from_utf8(pair).ok()?;
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b6f4f0e-2c1d-4c47-9a57-5d8a1e7f3c20";

    fn offer() -> (SharingKeyPair, PairingOffer) {
        let mac = SharingKeyPair::generate().unwrap();
        let offer = PairingOffer {
            api: "https://52-66-189-120.sslip.io".into(),
            id: ID.into(),
            public_key: mac.public_key(),
            secret: generate_secret().unwrap(),
        };
        (mac, offer)
    }

    #[test]
    fn offer_round_trips_through_the_qr_text() {
        let (_, offer) = offer();
        let uri = offer.to_uri();
        assert!(uri.starts_with("zvault://pair?v=1&api=https%3A%2F%2F52-66"));
        let parsed = PairingOffer::parse(&uri).unwrap();
        assert_eq!(parsed.api, offer.api);
        assert_eq!(parsed.id, offer.id);
        assert_eq!(parsed.public_key, offer.public_key);
        assert_eq!(*parsed.secret, *offer.secret);
    }

    #[test]
    fn rejects_other_codes() {
        let (_, offer) = offer();
        let uri = offer.to_uri();
        for bad in [
            "otpauth://totp/x?secret=ABC".to_owned(),
            uri.replace("v=1", "v=2"),
            uri.replace(ID, "not-a-uuid"),
            uri.replace(ID, &ID.to_uppercase()),
            uri.replace("api=https", "api=file"),
            format!("{uri}&s=AAAA"),
            uri.split("&s=").next().unwrap().to_owned(),
        ] {
            assert!(PairingOffer::parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn both_sides_compute_the_same_code_and_a_swapped_key_changes_it() {
        let (_, offer) = offer();
        let phone = SharingKeyPair::generate().unwrap();
        let attacker = SharingKeyPair::generate().unwrap();
        let code = verification_code(&offer.secret, &offer.public_key, &phone.public_key());
        assert_eq!(code.len(), CODE_DIGITS);
        assert!(code.bytes().all(|c| c.is_ascii_digit()));
        assert_eq!(
            code,
            verification_code(&offer.secret, &offer.public_key, &phone.public_key())
        );
        assert_ne!(
            code,
            verification_code(&offer.secret, &offer.public_key, &attacker.public_key())
        );
    }

    #[test]
    fn claim_token_is_not_the_secret() {
        let secret = generate_secret().unwrap();
        assert_ne!(claim_token(&secret), *secret);
        assert_eq!(claim_token(&secret), claim_token(&secret));
    }

    #[test]
    fn grant_opens_only_on_the_phone_for_this_pairing() {
        let (mac, offer) = offer();
        let phone = SharingKeyPair::generate().unwrap();
        let boxed = seal_grant(&mac, &phone.public_key(), ID, b"keyset").unwrap();
        assert_eq!(
            open_grant(&phone, &offer.public_key, ID, &boxed)
                .unwrap()
                .as_slice(),
            b"keyset"
        );

        let other_phone = SharingKeyPair::generate().unwrap();
        assert!(open_grant(&other_phone, &offer.public_key, ID, &boxed).is_err());
        let impostor = SharingKeyPair::generate().unwrap();
        assert!(open_grant(&phone, &impostor.public_key(), ID, &boxed).is_err());
        let other_id = "0b6f4f0e-2c1d-4c47-9a57-5d8a1e7f3c21";
        assert!(open_grant(&phone, &offer.public_key, other_id, &boxed).is_err());
    }
}

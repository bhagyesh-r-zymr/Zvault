//! Item sharing.
//!
//! Two ways to share, both end-to-end encrypted:
//!
//! * **Links** ([`LinkShare`]): a random 256-bit link key is generated on the
//!   sender's device and placed in the URL fragment (`#...`), which browsers
//!   never send to the server. From it we derive an encryption key and an
//!   access token. The server stores the ciphertext and `SHA-256(access token)`
//!   only, so it can gate views (expiry, view limit) without being able to
//!   decrypt, and someone who only knows the share id cannot fetch the
//!   ciphertext or burn a view.
//!
//! * **Boxes** ([`seal_to`] / [`open_from`]): shares addressed to another
//!   Zvault user. The item is encrypted to the recipient's X25519 sharing key
//!   with a key derived from two Diffie-Hellman results: ephemeral-to-recipient
//!   (forward secrecy for the sender) and sender-static-to-recipient (so the
//!   recipient knows which account sent it and the server cannot forge a share).
//!   Users compare [`fingerprint`]s out of band to rule out a server swapping
//!   public keys.

use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{Error, KEY_LEN, Result, Sealed, SymmetricKey, open, random, seal};

/// Share ids are 128 random bits chosen by the sender's device, so the
/// ciphertext can be bound to its id before the server ever sees it.
pub const SHARE_ID_LEN: usize = 16;
/// X25519 public and secret keys are 32 bytes.
pub const PUBLIC_KEY_LEN: usize = 32;

const LINK_ENC_INFO: &[u8] = b"zvault/v1/share-link/enc";
const LINK_AUTH_INFO: &[u8] = b"zvault/v1/share-link/auth";
const LINK_AAD_PREFIX: &[u8] = b"zvault/v1/share-link:";
const BOX_INFO: &[u8] = b"zvault/v1/share-box";
const BOX_AAD_PREFIX: &[u8] = b"zvault/v1/share-box:";
const FINGERPRINT_PREFIX: &[u8] = b"zvault/v1/sharing-key-fingerprint";

fn aad(prefix: &[u8], share_id: &[u8; SHARE_ID_LEN]) -> Vec<u8> {
    [prefix, share_id].concat()
}

/// A share link: its public id plus the secret key that goes in the URL fragment.
pub struct LinkShare {
    pub id: [u8; SHARE_ID_LEN],
    key: SymmetricKey,
}

impl LinkShare {
    pub fn generate() -> Result<Self> {
        Ok(Self {
            id: random::array()?,
            key: SymmetricKey::generate()?,
        })
    }

    /// Rebuilds a link from the id in its path and the key in its fragment.
    pub fn from_parts(id: [u8; SHARE_ID_LEN], key: [u8; KEY_LEN]) -> Self {
        Self {
            id,
            key: SymmetricKey::from_bytes(key),
        }
    }

    /// The link key, for the URL fragment only. Treat as secret.
    pub fn key_bytes(&self) -> &[u8; KEY_LEN] {
        self.key.as_bytes()
    }

    fn derive(&self, info: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        Hkdf::<Sha256>::new(Some(&self.id), self.key.as_bytes())
            .expand(info, out.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }

    /// Proves knowledge of the link key to the server. Sent only when opening.
    pub fn access_token(&self) -> Zeroizing<[u8; KEY_LEN]> {
        self.derive(LINK_AUTH_INFO)
    }

    /// What the server stores to check access tokens. Safe to send.
    pub fn verifier(&self) -> [u8; 32] {
        Sha256::digest(self.access_token().as_ref()).into()
    }

    fn enc_key(&self) -> SymmetricKey {
        SymmetricKey::from_bytes(*self.derive(LINK_ENC_INFO))
    }

    pub fn seal(&self, plaintext: &[u8]) -> Result<Sealed> {
        seal(&self.enc_key(), plaintext, &aad(LINK_AAD_PREFIX, &self.id))
    }

    pub fn open(&self, sealed: &Sealed) -> Result<Vec<u8>> {
        open(&self.enc_key(), sealed, &aad(LINK_AAD_PREFIX, &self.id))
    }
}

/// A user's long-term X25519 sharing key pair. Wiped from memory on drop.
pub struct SharingKeyPair {
    secret: StaticSecret,
}

impl SharingKeyPair {
    pub fn generate() -> Result<Self> {
        Ok(Self::from_secret_bytes(random::array()?))
    }

    /// The account's sharing key pair, derived from its keyset key. Every
    /// device signed in to the account gets the same pair, so recipients can
    /// pin the public key, and nothing new has to be stored or synced.
    pub fn derive_from_keyset(keyset: &SymmetricKey) -> Self {
        let mut okm = Zeroizing::new([0u8; KEY_LEN]);
        Hkdf::<Sha256>::new(None, keyset.as_bytes())
            .expand(b"zvault/sharing-x25519/v1", okm.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Self::from_secret_bytes(*okm)
    }

    pub fn from_secret_bytes(bytes: [u8; KEY_LEN]) -> Self {
        let bytes = Zeroizing::new(bytes);
        Self {
            secret: StaticSecret::from(*bytes),
        }
    }

    /// The secret half, for wrapping under the account keyset. Treat as secret.
    pub fn secret_bytes(&self) -> Zeroizing<[u8; KEY_LEN]> {
        Zeroizing::new(self.secret.to_bytes())
    }

    pub fn public_key(&self) -> [u8; PUBLIC_KEY_LEN] {
        PublicKey::from(&self.secret).to_bytes()
    }
}

/// A share encrypted to one recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoxedShare {
    pub ephemeral_public: [u8; PUBLIC_KEY_LEN],
    pub sealed: Sealed,
}

/// HKDF over both DH results, bound to all three public keys so a ciphertext
/// can't be replayed as coming from a different sender or to a different
/// recipient.
fn box_key(
    dh_ephemeral: &[u8; 32],
    dh_static: &[u8; 32],
    ephemeral: &[u8; 32],
    sender: &[u8; 32],
    recipient: &[u8; 32],
) -> SymmetricKey {
    let ikm = Zeroizing::new([dh_ephemeral.as_slice(), dh_static].concat());
    let salt = [ephemeral.as_slice(), sender, recipient].concat();
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(&salt), &ikm)
        .expand(BOX_INFO, out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    SymmetricKey::from_bytes(*out)
}

/// Rejects low-order points, which would make the shared secret all zeros.
fn diffie_hellman(secret: &StaticSecret, public: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    let shared = secret.diffie_hellman(&PublicKey::from(*public));
    if !shared.was_contributory() {
        return Err(Error::InvalidPublicKey);
    }
    Ok(Zeroizing::new(shared.to_bytes()))
}

/// Encrypts `plaintext` from `sender` to `recipient_public` for share `share_id`.
pub fn seal_to(
    sender: &SharingKeyPair,
    recipient_public: &[u8; PUBLIC_KEY_LEN],
    share_id: &[u8; SHARE_ID_LEN],
    plaintext: &[u8],
) -> Result<BoxedShare> {
    let ephemeral = SharingKeyPair::generate()?;
    let ephemeral_public = ephemeral.public_key();
    let key = box_key(
        &*diffie_hellman(&ephemeral.secret, recipient_public)?,
        &*diffie_hellman(&sender.secret, recipient_public)?,
        &ephemeral_public,
        &sender.public_key(),
        recipient_public,
    );
    let sealed = seal(&key, plaintext, &aad(BOX_AAD_PREFIX, share_id))?;
    Ok(BoxedShare {
        ephemeral_public,
        sealed,
    })
}

/// Decrypts a share addressed to `recipient`. Fails unless it was sealed by the
/// holder of `sender_public`'s secret key for exactly this `share_id`.
pub fn open_from(
    recipient: &SharingKeyPair,
    sender_public: &[u8; PUBLIC_KEY_LEN],
    share_id: &[u8; SHARE_ID_LEN],
    boxed: &BoxedShare,
) -> Result<Vec<u8>> {
    let key = box_key(
        &*diffie_hellman(&recipient.secret, &boxed.ephemeral_public)?,
        &*diffie_hellman(&recipient.secret, sender_public)?,
        &boxed.ephemeral_public,
        sender_public,
        &recipient.public_key(),
    );
    open(&key, &boxed.sealed, &aad(BOX_AAD_PREFIX, share_id))
}

/// A short, human-comparable digest of a sharing public key, e.g.
/// `3F2A 91C0 ...` (8 groups, 128 bits). Two people reading the same
/// fingerprint for an account know the server did not substitute its key.
pub fn fingerprint(public: &[u8; PUBLIC_KEY_LEN]) -> String {
    let digest = Sha256::new()
        .chain_update(FINGERPRINT_PREFIX)
        .chain_update(public)
        .finalize();
    digest[..16]
        .chunks(2)
        .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sharing_key_is_stable_per_keyset() {
        let keyset = SymmetricKey::from_bytes([7; KEY_LEN]);
        let a = SharingKeyPair::derive_from_keyset(&keyset);
        let b = SharingKeyPair::derive_from_keyset(&SymmetricKey::from_bytes([7; KEY_LEN]));
        let other = SharingKeyPair::derive_from_keyset(&SymmetricKey::from_bytes([8; KEY_LEN]));
        assert_eq!(a.public_key(), b.public_key());
        assert_ne!(a.public_key(), other.public_key());
    }

    #[test]
    fn link_round_trips_and_rebuilds_from_url_parts() {
        let link = LinkShare::generate().unwrap();
        let sealed = link.seal(b"hunter2").unwrap();
        let rebuilt = LinkShare::from_parts(link.id, *link.key_bytes());
        assert_eq!(rebuilt.open(&sealed).unwrap(), b"hunter2");
        assert_eq!(rebuilt.verifier(), link.verifier());
    }

    #[test]
    fn link_ciphertext_is_bound_to_its_id() {
        let link = LinkShare::generate().unwrap();
        let sealed = link.seal(b"secret").unwrap();
        let mut other_id = link.id;
        other_id[0] ^= 1;
        let moved = LinkShare::from_parts(other_id, *link.key_bytes());
        assert_eq!(moved.open(&sealed), Err(Error::Decrypt));
    }

    #[test]
    fn link_keys_are_independent() {
        let link = LinkShare::generate().unwrap();
        let token = link.access_token();
        assert_ne!(token.as_ref(), link.key_bytes());
        assert_ne!(token.as_ref(), link.enc_key().as_bytes());
        assert_ne!(&link.verifier(), token.as_ref());
    }

    /// Pinned so the browser recipient page (apps/share-web) can check it
    /// derives exactly the same keys. Update both sides together.
    #[test]
    fn link_derivation_matches_the_published_vector() {
        let link = LinkShare::from_parts([0x11; SHARE_ID_LEN], [0x22; KEY_LEN]);
        assert_eq!(
            hex(link.access_token().as_ref()),
            "187cc5b2a66cf01f738715d94d86c1ddf7e709740b48f117581b8dc3325b14ec"
        );
        assert_eq!(
            hex(&link.verifier()),
            "22eb56ba107177c1753fade4736c28f37f672663c5f142083f3dad6c80ce3c13"
        );
        assert_eq!(
            hex(link.enc_key().as_bytes()),
            "49de694cd99cac8f20b5f357e096cc62ecd2c8e467c8e43413ccf49bf8a2e6ac"
        );
    }

    /// Sealed by the browser implementation (apps/share-web) with a fixed
    /// nonce; proves the two sides agree on keys and associated data.
    #[test]
    fn link_opens_the_published_ciphertext() {
        let link = LinkShare::from_parts([0x11; SHARE_ID_LEN], [0x22; KEY_LEN]);
        let sealed = Sealed {
            nonce: [0x33; crate::NONCE_LEN],
            ciphertext: unhex(
                "3b1226ff80a6a8ffaeebbde812547fb72785df92bd5c213c75b2223ee0ab0ccc09f510305ed4e9a71d0869f10354783a6d48f7f4855aaf86c98864f6741d786f0aeb",
            ),
        };
        assert_eq!(
            link.open(&sealed).unwrap(),
            br#"{"v":1,"title":"Wi-Fi","password":"correct horse"}"#
        );
    }

    #[test]
    fn box_round_trips_between_users() {
        let alice = SharingKeyPair::generate().unwrap();
        let bob = SharingKeyPair::generate().unwrap();
        let id = [9; SHARE_ID_LEN];
        let boxed = seal_to(&alice, &bob.public_key(), &id, b"wifi password").unwrap();
        let opened = open_from(&bob, &alice.public_key(), &id, &boxed).unwrap();
        assert_eq!(opened, b"wifi password");
    }

    #[test]
    fn box_rejects_wrong_sender_recipient_or_id() {
        let alice = SharingKeyPair::generate().unwrap();
        let bob = SharingKeyPair::generate().unwrap();
        let mallory = SharingKeyPair::generate().unwrap();
        let id = [9; SHARE_ID_LEN];
        let boxed = seal_to(&alice, &bob.public_key(), &id, b"secret").unwrap();

        // The server claims Mallory sent it.
        assert_eq!(
            open_from(&bob, &mallory.public_key(), &id, &boxed),
            Err(Error::Decrypt)
        );
        // Someone other than Bob tries to open it.
        assert_eq!(
            open_from(&mallory, &alice.public_key(), &id, &boxed),
            Err(Error::Decrypt)
        );
        // The server moves it to a different share record.
        assert_eq!(
            open_from(&bob, &alice.public_key(), &[8; SHARE_ID_LEN], &boxed),
            Err(Error::Decrypt)
        );
    }

    #[test]
    fn box_rejects_low_order_public_keys() {
        let alice = SharingKeyPair::generate().unwrap();
        assert!(matches!(
            seal_to(&alice, &[0; 32], &[0; SHARE_ID_LEN], b"x"),
            Err(Error::InvalidPublicKey)
        ));
    }

    #[test]
    fn key_pair_round_trips_through_secret_bytes() {
        let a = SharingKeyPair::generate().unwrap();
        let b = SharingKeyPair::from_secret_bytes(*a.secret_bytes());
        assert_eq!(a.public_key(), b.public_key());
    }

    #[test]
    fn fingerprint_is_stable_and_grouped() {
        let fp = fingerprint(&[1; 32]);
        assert_eq!(fp, fingerprint(&[1; 32]));
        assert_ne!(fp, fingerprint(&[2; 32]));
        assert_eq!(fp.len(), 8 * 4 + 7);
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

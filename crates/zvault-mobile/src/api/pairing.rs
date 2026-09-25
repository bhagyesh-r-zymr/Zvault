//! The phone's side of signing in by scanning the Mac's QR code. See
//! `zvault_crypto::pairing` for the protocol.

use std::sync::{LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};
use zvault_crypto::pairing::{self, PairingOffer};
use zvault_crypto::{BoxedShare, KEY_LEN, Sealed, SharingKeyPair, SymmetricKey};

use super::keyring;
use crate::records::{decode_array, decode_key};

struct Pending {
    offer: PairingOffer,
    key_pair: SharingKeyPair,
}

static PENDING: LazyLock<Mutex<Option<Pending>>> = LazyLock::new(Mutex::default);

/// What a scan gives the app to call the server with and to show.
pub struct ScannedCode {
    /// API origin from the QR code.
    pub api: String,
    pub pairing_id: String,
    /// Proves to the server that this phone saw the QR code.
    pub claim_token: String,
    /// This phone's one-time public key.
    pub public_key: String,
    /// Six digits the Mac shows too.
    pub code: String,
}

/// The account the Mac handed over.
pub struct PairedAccount {
    pub email: String,
    /// The account keyset, for the app's biometric-protected store. It unlocks
    /// everything this account can see.
    pub keyset: String,
}

#[derive(Deserialize)]
struct GrantPlaintext {
    v: u32,
    email: String,
    keyset: String,
}

impl Drop for GrantPlaintext {
    fn drop(&mut self) {
        self.keyset.zeroize();
    }
}

const NOT_A_ZVAULT_CODE: &str =
    "That isn't a Zvault sign-in code. On your Mac, open Settings, Devices, Add phone.";

/// Reads a scanned (or pasted) QR code and makes this phone's one-time key.
pub fn pairing_scan(uri: String) -> anyhow::Result<ScannedCode> {
    let offer = PairingOffer::parse(&uri).ok_or_else(|| anyhow::anyhow!(NOT_A_ZVAULT_CODE))?;
    let key_pair = SharingKeyPair::generate()?;
    let public_key = key_pair.public_key();
    let scanned = ScannedCode {
        api: offer.api.clone(),
        pairing_id: offer.id.clone(),
        claim_token: B64.encode(pairing::claim_token(&offer.secret)),
        public_key: B64.encode(public_key),
        code: pairing::verification_code(&offer.secret, &offer.public_key, &public_key),
    };
    *pending() = Some(Pending { offer, key_pair });
    Ok(scanned)
}

/// Opens the grant the Mac sealed to this phone and unlocks with it.
pub fn pairing_finish(
    ephemeral_public_key: String,
    nonce: String,
    ct: String,
) -> anyhow::Result<PairedAccount> {
    let pending = pending()
        .take()
        .ok_or_else(|| anyhow::anyhow!("Scan the QR code again."))?;
    let boxed = BoxedShare {
        ephemeral_public: decode_key(&ephemeral_public_key)?,
        sealed: Sealed {
            nonce: decode_array(&nonce)?,
            ciphertext: B64.decode(ct.as_bytes())?,
        },
    };
    let json = pairing::open_grant(
        &pending.key_pair,
        &pending.offer.public_key,
        &pending.offer.id,
        &boxed,
    )
    .map_err(|_| anyhow::anyhow!("This sign-in didn't come from your Mac. Try again."))?;
    let grant: GrantPlaintext = serde_json::from_slice(&json)?;
    if grant.v != 1 {
        anyhow::bail!("Update Zvault on this phone to sign in.");
    }
    let bytes = Zeroizing::new(B64.decode(grant.keyset.as_bytes())?);
    let key: [u8; KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))?;
    keyring().unlock(grant.email.clone(), SymmetricKey::from_bytes(key));
    Ok(PairedAccount {
        email: grant.email.clone(),
        keyset: grant.keyset.clone(),
    })
}

/// Forgets a scan that won't be finished.
#[flutter_rust_bridge::frb(sync)]
pub fn pairing_cancel() {
    *pending() = None;
}

fn pending() -> std::sync::MutexGuard<'static, Option<Pending>> {
    PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Mac's side, as the desktop app does it.
    fn mac_offer(mac: &SharingKeyPair, id: &str) -> PairingOffer {
        PairingOffer {
            api: "http://localhost:3000".into(),
            id: id.into(),
            public_key: mac.public_key(),
            secret: pairing::generate_secret().unwrap(),
        }
    }

    #[test]
    fn scans_then_opens_the_macs_grant() {
        let id = "0b6f4f0e-2c1d-4c47-9a57-5d8a1e7f3c20";
        let mac = SharingKeyPair::generate().unwrap();
        let offer = mac_offer(&mac, id);
        let secret = *offer.secret;
        let scanned = pairing_scan(offer.to_uri()).unwrap();
        assert_eq!(scanned.pairing_id, id);
        assert_eq!(
            scanned.claim_token,
            B64.encode(pairing::claim_token(&secret))
        );

        // The Mac computes the same code from the key the server relayed.
        let phone_public = decode_key(&scanned.public_key).unwrap();
        assert_eq!(
            scanned.code,
            pairing::verification_code(&secret, &mac.public_key(), &phone_public)
        );

        let keyset = B64.encode([9u8; KEY_LEN]);
        let plaintext = serde_json::json!({"v": 1, "email": "me@example.com", "keyset": keyset});
        let boxed = pairing::seal_grant(
            &mac,
            &phone_public,
            id,
            &serde_json::to_vec(&plaintext).unwrap(),
        )
        .unwrap();
        let account = pairing_finish(
            B64.encode(boxed.ephemeral_public),
            B64.encode(boxed.sealed.nonce),
            B64.encode(&boxed.sealed.ciphertext),
        )
        .unwrap();
        assert_eq!(account.email, "me@example.com");
        assert_eq!(account.keyset, keyset);
        assert_eq!(
            super::super::session::unlocked_email().as_deref(),
            Some("me@example.com")
        );
        super::super::session::lock();
    }

    #[test]
    fn rejects_other_qr_codes() {
        assert!(pairing_scan("https://example.com".into()).is_err());
    }
}

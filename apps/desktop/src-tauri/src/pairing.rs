//! Adding a phone by QR code. This Mac makes a one-time key pair and pairing
//! secret, shows them as a QR code, and once the person allows the phone that
//! claimed it, seals the account keyset to that phone. The UI relays the
//! server calls; the secret and the keyset never leave Rust except inside the
//! QR code and the sealed grant.

use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Serialize;
use tauri::{AppHandle, State};
use zeroize::Zeroizing;
use zvault_crypto::pairing::{self, PairingOffer};
use zvault_crypto::{KEY_LEN, PUBLIC_KEY_LEN, SharingKeyPair};

/// Plaintext of the grant, versioned. The phone parses the same shape.
#[derive(Serialize)]
struct GrantPlaintext<'a> {
    v: u32,
    email: &'a str,
    keyset: String,
}

struct Pending {
    key_pair: SharingKeyPair,
    secret: Zeroizing<[u8; KEY_LEN]>,
    id: Option<String>,
}

/// The pairing on screen, if any. Starting a new one replaces it.
#[derive(Default)]
pub struct PendingPairing(Mutex<Option<Pending>>);

impl PendingPairing {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

type PairingState<'a> = State<'a, PendingPairing>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStart {
    /// Registered with `POST /pairings`; the server keeps only its hash.
    claim_token: String,
}

/// Mirrors `PairingGrant` in `@zvault/shared`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingGrant {
    ephemeral_public_key: String,
    nonce: String,
    ct: String,
}

const NOT_STARTED: &str = "Show a new QR code and try again.";

/// Makes a fresh key pair and pairing secret for a new QR code.
#[tauri::command]
pub fn pairing_begin(state: PairingState<'_>) -> Result<PairingStart, String> {
    let key_pair = SharingKeyPair::generate().map_err(|e| e.to_string())?;
    let secret = pairing::generate_secret().map_err(|e| e.to_string())?;
    let claim_token = B64.encode(pairing::claim_token(&secret));
    *state.slot() = Some(Pending {
        key_pair,
        secret,
        id: None,
    });
    Ok(PairingStart { claim_token })
}

/// The text of the QR code, once the server has given the pairing an id.
#[tauri::command]
pub fn pairing_qr(state: PairingState<'_>, id: String, api: String) -> Result<String, String> {
    let mut slot = state.slot();
    let pending = slot.as_mut().ok_or(NOT_STARTED)?;
    let offer = PairingOffer {
        api,
        id: id.clone(),
        public_key: pending.key_pair.public_key(),
        secret: pending.secret.clone(),
    };
    let uri = offer.to_uri();
    // Refuse anything the phone would refuse, such as a non-canonical id.
    PairingOffer::parse(&uri).ok_or("invalid pairing")?;
    pending.id = Some(id);
    Ok(uri)
}

/// The six-digit code for the phone that claimed the pairing.
#[tauri::command]
pub fn pairing_code(state: PairingState<'_>, public_key: String) -> Result<String, String> {
    let slot = state.slot();
    let pending = slot.as_ref().ok_or(NOT_STARTED)?;
    Ok(pairing::verification_code(
        &pending.secret,
        &pending.key_pair.public_key(),
        &decode_key(&public_key)?,
    ))
}

/// Seals this account's keyset to the phone. Ends the pairing on this Mac.
#[tauri::command]
pub fn pairing_grant(
    app: AppHandle,
    state: PairingState<'_>,
    public_key: String,
) -> Result<PairingGrant, String> {
    let phone = decode_key(&public_key)?;
    let pending = state.slot().take().ok_or(NOT_STARTED)?;
    let id = pending.id.as_deref().ok_or(NOT_STARTED)?;
    let plaintext = crate::auth::with_account(&app, |email, keyset| {
        serde_json::to_vec(&GrantPlaintext {
            v: 1,
            email,
            keyset: B64.encode(keyset.as_bytes()),
        })
        .map(Zeroizing::new)
    })
    .ok_or("Unlock Zvault to add a phone.")?
    .map_err(|_| "internal error")?;
    let boxed = pairing::seal_grant(&pending.key_pair, &phone, id, &plaintext)
        .map_err(|e| e.to_string())?;
    Ok(PairingGrant {
        ephemeral_public_key: B64.encode(boxed.ephemeral_public),
        nonce: B64.encode(boxed.sealed.nonce),
        ct: B64.encode(&boxed.sealed.ciphertext),
    })
}

/// Forgets the pairing on screen.
#[tauri::command]
pub fn pairing_cancel(state: PairingState<'_>) {
    *state.slot() = None;
}

fn decode_key(s: &str) -> Result<[u8; PUBLIC_KEY_LEN], String> {
    B64.decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| "That phone sent an invalid key.".into())
}

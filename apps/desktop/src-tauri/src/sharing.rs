//! Sharing commands. Link keys and the sharing secret key are created and
//! used here; the UI receives ciphertext, public keys and, for links, the
//! finished URL it has to show the user.

use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use tauri::State;
use zvault_crypto::{
    BoxedShare, LinkShare, NONCE_LEN, PUBLIC_KEY_LEN, SHARE_ID_LEN, Sealed, SharingKeyPair,
    fingerprint, open_from, seal_to,
};

use crate::CRYPTO_VERSION;

/// The signed-in user's sharing key pair, held only while the app is unlocked.
///
/// TODO(keyset): persist the secret half wrapped under the account keyset once
/// sign-in lands, instead of generating a new pair per session.
#[derive(Default)]
pub struct SharingState(Mutex<Option<SharingKeyPair>>);

/// Wire form of `EncryptedBlob` in `@zvault/shared`.
#[derive(Serialize, Deserialize)]
pub struct WireBlob {
    v: u32,
    alg: String,
    kid: String,
    nonce: String,
    ct: String,
}

impl WireBlob {
    fn from_sealed(kid: &str, sealed: &Sealed) -> Self {
        Self {
            v: CRYPTO_VERSION,
            alg: "xchacha20poly1305".into(),
            kid: kid.into(),
            nonce: B64.encode(sealed.nonce),
            ct: B64.encode(&sealed.ciphertext),
        }
    }

    fn to_sealed(&self, kid: &str) -> Result<Sealed, String> {
        if self.v != CRYPTO_VERSION || self.alg != "xchacha20poly1305" || self.kid != kid {
            return Err("unsupported share format".into());
        }
        Ok(Sealed {
            nonce: decode_array::<NONCE_LEN>(&self.nonce)?,
            ciphertext: B64.decode(&self.ct).map_err(|_| "malformed share")?,
        })
    }
}

fn decode_array<const N: usize>(s: &str) -> Result<[u8; N], String> {
    B64.decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| "malformed share".into())
}

fn err(e: zvault_crypto::Error) -> String {
    e.to_string()
}

/// Share pages may only be served over HTTPS (or from localhost in development).
fn check_origin(origin: &str) -> Result<&str, String> {
    let origin = origin.trim_end_matches('/');
    let ok = origin.starts_with("https://")
        || origin.starts_with("http://localhost:")
        || origin == "http://localhost";
    if !ok || origin.contains(['#', '?', ' ']) {
        return Err("share page origin must be https".into());
    }
    Ok(origin)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewShareLink {
    id: String,
    verifier: String,
    blob: WireBlob,
    /// Contains the link key in its fragment. Show once; never send to the API.
    url: String,
}

/// Encrypts an item under a fresh link key and builds its URL.
#[tauri::command]
pub fn share_link_create(payload: String, share_origin: String) -> Result<NewShareLink, String> {
    let origin = check_origin(&share_origin)?;
    let link = LinkShare::generate().map_err(err)?;
    let sealed = link.seal(payload.as_bytes()).map_err(err)?;
    let id = B64.encode(link.id);
    Ok(NewShareLink {
        url: format!("{origin}/#{id}.{}", B64.encode(link.key_bytes())),
        verifier: B64.encode(link.verifier()),
        blob: WireBlob::from_sealed("share-link", &sealed),
        id,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingIdentity {
    public_key: String,
    fingerprint: String,
}

fn identity_of(pair: &SharingKeyPair) -> SharingIdentity {
    let public = pair.public_key();
    SharingIdentity {
        public_key: B64.encode(public),
        fingerprint: fingerprint(&public),
    }
}

/// Returns this device's sharing identity, creating the key pair if needed.
#[tauri::command]
pub fn sharing_identity(state: State<'_, SharingState>) -> Result<SharingIdentity, String> {
    let mut guard = state.0.lock().map_err(|_| "sharing state unavailable")?;
    if guard.is_none() {
        *guard = Some(SharingKeyPair::generate().map_err(err)?);
    }
    Ok(identity_of(guard.as_ref().expect("set above")))
}

/// Fingerprint of someone else's key, for comparing out of band.
#[tauri::command]
pub fn sharing_fingerprint(public_key: String) -> Result<String, String> {
    Ok(fingerprint(&decode_array::<PUBLIC_KEY_LEN>(&public_key)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUserShare {
    id: String,
    sender_public_key: String,
    ephemeral_public_key: String,
    blob: WireBlob,
}

/// Encrypts an item to another user's sharing key.
#[tauri::command]
pub fn share_seal_to(
    state: State<'_, SharingState>,
    recipient_public_key: String,
    payload: String,
) -> Result<NewUserShare, String> {
    let guard = state.0.lock().map_err(|_| "sharing state unavailable")?;
    let me = guard.as_ref().ok_or("sharing key not set up")?;
    let recipient = decode_array::<PUBLIC_KEY_LEN>(&recipient_public_key)?;
    let id: [u8; SHARE_ID_LEN] = LinkShare::generate().map_err(err)?.id;
    let boxed = seal_to(me, &recipient, &id, payload.as_bytes()).map_err(err)?;
    Ok(NewUserShare {
        id: B64.encode(id),
        sender_public_key: B64.encode(me.public_key()),
        ephemeral_public_key: B64.encode(boxed.ephemeral_public),
        blob: WireBlob::from_sealed("share-box", &boxed.sealed),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingShare {
    id: String,
    sender_public_key: String,
    ephemeral_public_key: String,
    blob: WireBlob,
}

/// Decrypts a share sent to this user. Fails if it was not sealed by the
/// holder of `senderPublicKey` for exactly this share id.
#[tauri::command]
pub fn share_open(state: State<'_, SharingState>, share: IncomingShare) -> Result<String, String> {
    let guard = state.0.lock().map_err(|_| "sharing state unavailable")?;
    let me = guard.as_ref().ok_or("sharing key not set up")?;
    let boxed = BoxedShare {
        ephemeral_public: decode_array(&share.ephemeral_public_key)?,
        sealed: share.blob.to_sealed("share-box")?,
    };
    let plaintext = open_from(
        me,
        &decode_array(&share.sender_public_key)?,
        &decode_array(&share.id)?,
        &boxed,
    )
    .map_err(err)?;
    String::from_utf8(plaintext).map_err(|_| "malformed share".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_url_carries_id_and_key_in_the_fragment() {
        let link = share_link_create("{}".into(), "https://share.example/".into()).unwrap();
        let (base, fragment) = link.url.split_once('#').unwrap();
        assert_eq!(base, "https://share.example/");
        let (id, key) = fragment.split_once('.').unwrap();
        assert_eq!(id, link.id);
        assert_eq!(key.len(), 43);
        assert_eq!(link.blob.kid, "share-link");

        let rebuilt = LinkShare::from_parts(decode_array(id).unwrap(), decode_array(key).unwrap());
        let sealed = link.blob.to_sealed("share-link").unwrap();
        assert_eq!(rebuilt.open(&sealed).unwrap(), b"{}");
        assert_eq!(B64.encode(rebuilt.verifier()), link.verifier);
    }

    #[test]
    fn refuses_insecure_share_origins() {
        for bad in ["http://share.example", "javascript:alert(1)", "https://a#b"] {
            assert!(share_link_create("{}".into(), bad.into()).is_err(), "{bad}");
        }
        assert!(share_link_create("{}".into(), "http://localhost:1430".into()).is_ok());
    }
}

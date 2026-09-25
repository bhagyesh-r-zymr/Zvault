//! Sharing commands. Link keys and the sharing secret key are created and
//! used here; the UI receives ciphertext, public keys and, for links, the
//! finished URL it has to show the user.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zvault_crypto::{
    BoxedShare, LinkShare, NONCE_LEN, PUBLIC_KEY_LEN, SHARE_ID_LEN, Sealed, SharingKeyPair,
    fingerprint, open_from, seal_to,
};

use crate::CRYPTO_VERSION;

/// The signed-in account's sharing key pair, derived from its keyset so it is
/// the same on every device and across restarts. Fails while locked.
fn my_key_pair(app: &AppHandle) -> Result<SharingKeyPair, String> {
    crate::auth::with_keyset(app, SharingKeyPair::derive_from_keyset)
        .ok_or_else(|| "Unlock Zvault to share.".into())
}

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

/// Returns the account's sharing identity.
#[tauri::command]
pub fn sharing_identity(app: AppHandle) -> Result<SharingIdentity, String> {
    Ok(identity_of(&my_key_pair(&app)?))
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
    app: AppHandle,
    recipient_public_key: String,
    payload: String,
) -> Result<NewUserShare, String> {
    let me = &my_key_pair(&app)?;
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
pub fn share_open(app: AppHandle, share: IncomingShare) -> Result<String, String> {
    let me = &my_key_pair(&app)?;
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

/// Percent-encodes everything but RFC 3986 unreserved characters.
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

/// A `mailto:` URL for the user's own mail app. Addresses must be plain
/// `local@domain` so nothing can smuggle extra headers into the URL.
fn mailto_url(to: &[String], subject: &str, body: &str) -> Result<String, String> {
    if to.is_empty() || to.len() > 20 {
        return Err("Add between 1 and 20 email addresses.".into());
    }
    let plain = |a: &String| {
        let mut parts = a.split('@');
        let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty());
        ok(parts.next())
            && ok(parts.next())
            && parts.next().is_none()
            && a.len() <= 254
            && a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "@.-_+'".contains(c))
    };
    if let Some(bad) = to.iter().find(|a| !plain(a)) {
        return Err(format!("{bad} is not an email address."));
    }
    let to: Vec<String> = to.iter().map(|a| percent_encode(a)).collect();
    Ok(format!(
        "mailto:{}?subject={}&body={}",
        to.join(","),
        percent_encode(subject),
        percent_encode(body)
    ))
}

/// Opens a new message in the user's own mail app. The share link (and its
/// key) goes from their mailbox; it never passes through Zvault's servers.
#[tauri::command]
pub fn share_compose_email(to: Vec<String>, subject: String, body: String) -> Result<(), String> {
    let url = mailto_url(&to, &subject, &body)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open your mail app: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailto_encodes_everything_and_refuses_odd_addresses() {
        let url = mailto_url(
            &["a@x.com".into(), "b+c@y.org".into()],
            "Hi & bye",
            "Open https://h/share/#id.key\nThanks",
        )
        .unwrap();
        assert_eq!(
            url,
            "mailto:a%40x.com,b%2Bc%40y.org?subject=Hi%20%26%20bye&body=Open%20https%3A%2F%2Fh%2Fshare%2F%23id.key%0AThanks"
        );
        for bad in [
            "a@b.com?cc=evil@x.com",
            "nobody",
            "a@b@c",
            "a b@c.com",
            "@b.com",
        ] {
            assert!(mailto_url(&[bad.into()], "s", "b").is_err(), "{bad}");
        }
        assert!(mailto_url(&[], "s", "b").is_err());
    }

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

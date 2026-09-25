//! Sharing an item, as the Mac does it: by secure link, or sealed to another
//! Zvault user. The item is opened and encrypted here, so its password never
//! reaches Dart; Dart gets ciphertext, public keys and, for links, the URL to
//! hand to the share sheet.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Serialize;
use zeroize::Zeroizing;
use zvault_crypto::{
    LinkShare, PUBLIC_KEY_LEN, SHARE_ID_LEN, Sealed, SharingKeyPair, fingerprint, seal_to,
};

use super::keyring;
use crate::keyring::ItemFields;
use crate::records::{self, CRYPTO_VERSION, ItemRecord, decode_key};

/// `SHARE_LINK_KID` and `SHARE_BOX_KID` in `@zvault/shared`.
const LINK_KID: &str = "share-link";
const BOX_KID: &str = "share-box";

/// A link ready to register with `POST /shares/links`.
pub struct NewShareLink {
    pub id: String,
    pub verifier: String,
    /// `EncryptedBlob` as JSON.
    pub blob_json: String,
    /// Carries the link key in its fragment. Show and share it; never send it
    /// to the API.
    pub url: String,
}

/// A share sealed to another user, ready for `POST /shares/users`.
pub struct NewUserShare {
    pub id: String,
    pub sender_public_key: String,
    pub ephemeral_public_key: String,
    /// `EncryptedBlob` as JSON.
    pub blob_json: String,
}

pub struct SharingIdentity {
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Serialize)]
struct WireBlob<'a> {
    v: u32,
    alg: &'a str,
    kid: &'a str,
    nonce: String,
    ct: String,
}

fn blob_json(kid: &str, sealed: &Sealed) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&WireBlob {
        v: CRYPTO_VERSION,
        alg: "xchacha20poly1305",
        kid,
        nonce: B64.encode(sealed.nonce),
        ct: B64.encode(&sealed.ciphertext),
    })?)
}

/// `SharedItemPayload`. Empty fields are left out, as the Mac does.
/// One-time password seeds are not shared.
#[derive(Serialize)]
struct Payload<'a> {
    v: u32,
    title: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    username: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    password: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    url: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    notes: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    passkey: Option<SharedPasskey<'a>>,
}

/// `SharedPasskey`: everything needed to use the passkey elsewhere.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedPasskey<'a> {
    rp_id: &'a str,
    user_name: &'a str,
    user_handle: &'a str,
    credential_id: &'a str,
    private_key: &'a str,
}

fn payload(f: &ItemFields) -> anyhow::Result<Zeroizing<Vec<u8>>> {
    let pem = f
        .passkey
        .as_ref()
        .map(|p| p.private_key_pem())
        .transpose()?;
    Ok(Zeroizing::new(serde_json::to_vec(&Payload {
        v: 1,
        title: &f.title,
        username: &f.username,
        password: &f.password,
        url: f.urls.first().map_or("", String::as_str),
        notes: &f.notes,
        passkey: f
            .passkey
            .as_ref()
            .zip(pem.as_ref())
            .map(|(p, pem)| SharedPasskey {
                rp_id: &p.rp_id,
                user_name: &p.user_name,
                user_handle: &p.user_handle,
                credential_id: &p.credential_id,
                private_key: pem,
            }),
    })?))
}

fn open_payload(vault_id: &str, record_json: &str) -> anyhow::Result<Zeroizing<Vec<u8>>> {
    let record: ItemRecord = records::parse(record_json)?;
    let fields = keyring().open_item(vault_id, &record)?;
    payload(&fields)
}

/// Share pages may only be served over HTTPS (or from localhost in development).
fn check_origin(origin: &str) -> anyhow::Result<&str> {
    let origin = origin.trim_end_matches('/');
    let ok = origin.starts_with("https://")
        || origin.starts_with("http://localhost:")
        || origin == "http://localhost";
    if !ok || origin.contains(['#', '?', ' ']) {
        anyhow::bail!("This server can't host share links: it isn't using HTTPS.");
    }
    Ok(origin)
}

/// Encrypts an item under a fresh link key and builds its URL on
/// `share_origin` (the share page, such as `https://host/share`).
pub fn share_link_create(
    vault_id: String,
    record_json: String,
    share_origin: String,
) -> anyhow::Result<NewShareLink> {
    let origin = check_origin(&share_origin)?;
    seal_link(&open_payload(&vault_id, &record_json)?, origin)
}

fn seal_link(plaintext: &[u8], origin: &str) -> anyhow::Result<NewShareLink> {
    let link = LinkShare::generate()?;
    let sealed = link.seal(plaintext)?;
    let id = B64.encode(link.id);
    Ok(NewShareLink {
        url: format!("{origin}/#{id}.{}", B64.encode(link.key_bytes())),
        verifier: B64.encode(link.verifier()),
        blob_json: blob_json(LINK_KID, &sealed)?,
        id,
    })
}

/// This account's sharing public key, to publish before sending a share.
pub fn sharing_identity() -> anyhow::Result<SharingIdentity> {
    let public = keyring().sharing_key_pair()?.public_key();
    Ok(SharingIdentity {
        public_key: B64.encode(public),
        fingerprint: fingerprint(&public),
    })
}

/// Someone else's security code, for comparing out of band.
pub fn sharing_fingerprint(public_key: String) -> anyhow::Result<String> {
    Ok(fingerprint(&decode_key(&public_key)?))
}

/// Encrypts an item to another user's sharing key.
pub fn share_seal_to(
    vault_id: String,
    record_json: String,
    recipient_public_key: String,
) -> anyhow::Result<NewUserShare> {
    let recipient = decode_key(&recipient_public_key)?;
    let plaintext = open_payload(&vault_id, &record_json)?;
    let me = keyring().sharing_key_pair()?;
    seal_box(&me, &recipient, &plaintext)
}

fn seal_box(
    me: &SharingKeyPair,
    recipient: &[u8; PUBLIC_KEY_LEN],
    plaintext: &[u8],
) -> anyhow::Result<NewUserShare> {
    let id: [u8; SHARE_ID_LEN] = LinkShare::generate()?.id;
    let boxed = seal_to(me, recipient, &id, plaintext)?;
    Ok(NewUserShare {
        id: B64.encode(id),
        sender_public_key: B64.encode(me.public_key()),
        ephemeral_public_key: B64.encode(boxed.ephemeral_public),
        blob_json: blob_json(BOX_KID, &boxed.sealed)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{Blob, decode_array};
    use zvault_crypto::{BoxedShare, KEY_LEN, open_from};

    fn fields() -> ItemFields {
        ItemFields {
            title: "GitHub".into(),
            username: "octo".into(),
            password: "hunter2".into(),
            urls: vec![
                "https://github.com".into(),
                "https://gist.github.com".into(),
            ],
            notes: String::new(),
            totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP".into(),
            passkey: None,
        }
    }

    #[test]
    fn payload_carries_the_passkey_with_its_private_key() {
        let mut f = fields();
        let passkey = zvault_passkeys::Passkey::generate("github.com", "octo", 0).unwrap();
        f.passkey = Some(passkey.clone());
        let json: serde_json::Value = serde_json::from_slice(&payload(&f).unwrap()).unwrap();
        let shared = &json["passkey"];
        assert_eq!(shared["rpId"], "github.com");
        assert_eq!(shared["credentialId"], passkey.credential_id.as_str());
        let pem = shared["privateKey"].as_str().unwrap();
        let back = zvault_passkeys::Passkey::import(
            "github.com",
            "octo",
            &passkey.credential_id,
            "",
            pem,
            0,
        )
        .unwrap();
        assert_eq!(back.public_key(), passkey.public_key());
    }

    #[test]
    fn payload_matches_the_macs_and_leaves_out_the_totp_seed() {
        let json: serde_json::Value = serde_json::from_slice(&payload(&fields()).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "v": 1, "title": "GitHub", "username": "octo",
                "password": "hunter2", "url": "https://github.com"
            })
        );
    }

    #[test]
    fn link_url_carries_id_and_key_in_the_fragment() {
        let origin = check_origin("https://host.example/share/").unwrap();
        let link = seal_link(b"{}", origin).unwrap();
        let (base, fragment) = link.url.split_once('#').unwrap();
        assert_eq!(base, "https://host.example/share/");
        let (id, key) = fragment.split_once('.').unwrap();
        assert_eq!(id, link.id);

        let blob: Blob = records::parse(&link.blob_json).unwrap();
        let rebuilt = LinkShare::from_parts(
            decode_array::<SHARE_ID_LEN>(id).unwrap(),
            decode_array::<KEY_LEN>(key).unwrap(),
        );
        assert_eq!(
            rebuilt.open(&blob.sealed(LINK_KID).unwrap()).unwrap(),
            b"{}"
        );
        assert_eq!(B64.encode(rebuilt.verifier()), link.verifier);
    }

    #[test]
    fn refuses_insecure_share_origins() {
        for bad in ["http://share.example", "javascript:alert(1)", "https://a#b"] {
            assert!(check_origin(bad).is_err(), "{bad}");
        }
        assert!(check_origin("http://localhost:1430").is_ok());
    }

    #[test]
    fn user_share_opens_only_for_the_recipient() {
        let me = SharingKeyPair::generate().unwrap();
        let them = SharingKeyPair::generate().unwrap();
        let share = seal_box(&me, &them.public_key(), b"secret").unwrap();
        let blob: Blob = records::parse(&share.blob_json).unwrap();
        let boxed = BoxedShare {
            ephemeral_public: decode_key(&share.ephemeral_public_key).unwrap(),
            sealed: blob.sealed(BOX_KID).unwrap(),
        };
        let id = decode_array::<SHARE_ID_LEN>(&share.id).unwrap();
        let sender = decode_key(&share.sender_public_key).unwrap();
        assert_eq!(open_from(&them, &sender, &id, &boxed).unwrap(), b"secret");
        assert!(open_from(&me, &sender, &id, &boxed).is_err());
    }
}

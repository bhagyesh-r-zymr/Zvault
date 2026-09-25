//! Passkeys kept inside vault items, like 1Password's passkey field. A
//! passkey is a WebAuthn credential: an ES256 (P-256) key pair bound to one
//! website (the relying party id) and one account on it. The private key is
//! stored, encrypted, in the item and used only here, on the device.
//!
//! This crate creates and imports passkeys and signs WebAuthn assertions
//! with them. It does not talk to the network or to the operating system's
//! passkey APIs.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PasskeyError {
    #[error("Enter the website as a domain, such as github.com.")]
    InvalidWebsite,
    #[error("Enter the user name or email the passkey is for.")]
    MissingUser,
    #[error("The credential ID must be base64url, 16 to 1023 bytes.")]
    InvalidCredentialId,
    #[error("The user handle must be base64url, 1 to 64 bytes.")]
    InvalidUserHandle,
    #[error("The private key must be a P-256 (ES256) key in PKCS#8 PEM or base64.")]
    InvalidPrivateKey,
    #[error("This passkey is damaged.")]
    Damaged,
    #[error("Could not create a passkey.")]
    Random,
    #[error("The signature did not verify.")]
    Verify,
}

pub type Result<T> = core::result::Result<T, PasskeyError>;

/// COSE algorithm id of ES256, the only one supported.
pub const ES256: i32 = -7;

const MAX_RP_ID: usize = 253;
const MAX_USER_NAME: usize = 256;
const CREDENTIAL_ID_BYTES: usize = 16;
const USER_HANDLE_BYTES: usize = 16;
/// WebAuthn allows credential ids up to 1023 bytes, user handles up to 64.
const MAX_CREDENTIAL_ID: usize = 1023;
const MAX_USER_HANDLE: usize = 64;

/// Authenticator data flags: user present, user verified, backup eligible
/// and backed up (a synced passkey).
const FLAGS: u8 = 0x01 | 0x04 | 0x08 | 0x10;

/// A stored passkey. Binary fields are base64url without padding, the form
/// WebAuthn uses on the wire. The private key is PKCS#8 DER and is wiped on
/// drop.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    /// Relying party id: the website's domain, such as `github.com`.
    pub rp_id: String,
    /// The account on that website, as the site named it.
    pub user_name: String,
    /// The site's opaque id for the account (`user.id`).
    pub user_handle: String,
    pub credential_id: String,
    private_key: String,
    /// When the passkey was created or imported, in Unix seconds.
    #[zeroize(skip)]
    pub created_at: i64,
}

impl std::fmt::Debug for Passkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Passkey")
            .field("rp_id", &self.rp_id)
            .field("credential_id", &self.credential_id)
            .finish_non_exhaustive()
    }
}

/// What an authenticator returns for `navigator.credentials.get()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assertion {
    pub authenticator_data: Vec<u8>,
    pub client_data_json: Vec<u8>,
    /// ASN.1 DER ECDSA signature over `authenticator_data || SHA-256(client_data_json)`.
    pub signature: Vec<u8>,
}

impl Passkey {
    /// Creates a new passkey for `user_name` on `website`.
    pub fn generate(website: &str, user_name: &str, now: i64) -> Result<Self> {
        let key = random_signing_key()?;
        let mut id = [0u8; CREDENTIAL_ID_BYTES];
        let mut handle = [0u8; USER_HANDLE_BYTES];
        getrandom::fill(&mut id).map_err(|_| PasskeyError::Random)?;
        getrandom::fill(&mut handle).map_err(|_| PasskeyError::Random)?;
        Ok(Self {
            rp_id: rp_id(website)?,
            user_name: user(user_name)?,
            user_handle: B64.encode(handle),
            credential_id: B64.encode(id),
            private_key: encode_key(&key)?,
            created_at: now,
        })
    }

    /// Imports an existing passkey, such as one exported from another
    /// password manager. An empty `user_handle` gets a random one.
    pub fn import(
        website: &str,
        user_name: &str,
        credential_id: &str,
        user_handle: &str,
        private_key: &str,
        now: i64,
    ) -> Result<Self> {
        let credential_id =
            base64url(credential_id, MAX_CREDENTIAL_ID).ok_or(PasskeyError::InvalidCredentialId)?;
        let user_handle = if user_handle.trim().is_empty() {
            let mut handle = [0u8; USER_HANDLE_BYTES];
            getrandom::fill(&mut handle).map_err(|_| PasskeyError::Random)?;
            B64.encode(handle)
        } else {
            base64url(user_handle, MAX_USER_HANDLE).ok_or(PasskeyError::InvalidUserHandle)?
        };
        let key = parse_private_key(private_key)?;
        Ok(Self {
            rp_id: rp_id(website)?,
            user_name: user(user_name)?,
            user_handle,
            credential_id,
            private_key: encode_key(&key)?,
            created_at: now,
        })
    }

    /// Changes the account name shown for this passkey. The website and keys
    /// never change: a passkey is bound to them.
    pub fn rename_user(&mut self, user_name: &str) -> Result<()> {
        self.user_name = user(user_name)?;
        Ok(())
    }

    /// Checks a stored passkey decodes, so a damaged one is caught on open.
    pub fn validate(&self) -> Result<()> {
        rp_id(&self.rp_id)
            .ok()
            .filter(|r| *r == self.rp_id)
            .ok_or(PasskeyError::Damaged)?;
        base64url(&self.credential_id, MAX_CREDENTIAL_ID).ok_or(PasskeyError::Damaged)?;
        base64url(&self.user_handle, MAX_USER_HANDLE).ok_or(PasskeyError::Damaged)?;
        self.signing_key().map(|_| ())
    }

    /// The public key as base64url SubjectPublicKeyInfo DER, which is what
    /// a site stores and what `getPublicKey()` returns in a browser.
    pub fn public_key(&self) -> Result<String> {
        let der = self
            .signing_key()?
            .verifying_key()
            .to_public_key_der()
            .map_err(|_| PasskeyError::Damaged)?;
        Ok(B64.encode(der.as_bytes()))
    }

    /// The private key as PKCS#8 PEM, for sharing or moving the passkey to
    /// another manager.
    pub fn private_key_pem(&self) -> Result<Zeroizing<String>> {
        self.signing_key()?
            .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .map_err(|_| PasskeyError::Damaged)
    }

    /// Signs a WebAuthn assertion for `challenge`, as the browser would
    /// request when signing in at `origin`.
    pub fn sign_assertion(&self, challenge: &[u8], origin: &str) -> Result<Assertion> {
        let key = self.signing_key()?;
        let mut authenticator_data = Sha256::digest(self.rp_id.as_bytes()).to_vec();
        authenticator_data.push(FLAGS);
        // Synced passkeys report a zero signature counter.
        authenticator_data.extend_from_slice(&0u32.to_be_bytes());
        let client_data_json = serde_json::to_vec(&ClientData {
            kind: "webauthn.get",
            challenge: &B64.encode(challenge),
            origin,
            cross_origin: false,
        })
        .map_err(|_| PasskeyError::Damaged)?;
        let signature: Signature = key.sign(&signed_bytes(&authenticator_data, &client_data_json));
        Ok(Assertion {
            authenticator_data,
            client_data_json,
            signature: signature.to_der().as_bytes().to_vec(),
        })
    }

    /// Signs a fresh challenge from this passkey's website and checks it the
    /// way the website would, using only the public key. Proves the stored
    /// key still works without contacting the site.
    pub fn self_test(&self) -> Result<()> {
        let mut challenge = [0u8; 32];
        getrandom::fill(&mut challenge).map_err(|_| PasskeyError::Random)?;
        let origin = format!("https://{}", self.rp_id);
        let assertion = self.sign_assertion(&challenge, &origin)?;
        verify_assertion(
            &self.public_key()?,
            &self.rp_id,
            &origin,
            &challenge,
            &assertion,
        )
    }

    fn signing_key(&self) -> Result<SigningKey> {
        let der = Zeroizing::new(
            B64.decode(&self.private_key)
                .map_err(|_| PasskeyError::Damaged)?,
        );
        SigningKey::from_pkcs8_der(&der).map_err(|_| PasskeyError::Damaged)
    }
}

/// Verifies an assertion as a relying party does: the rp id hash, the user
/// present flag, the client data and the signature.
pub fn verify_assertion(
    public_key: &str,
    rp_id: &str,
    origin: &str,
    challenge: &[u8],
    assertion: &Assertion,
) -> Result<()> {
    let der = B64.decode(public_key).map_err(|_| PasskeyError::Verify)?;
    let key = VerifyingKey::from_public_key_der(&der).map_err(|_| PasskeyError::Verify)?;
    let data = &assertion.authenticator_data;
    if data.len() < 37 || data[..32] != Sha256::digest(rp_id.as_bytes())[..] || data[32] & 0x01 == 0
    {
        return Err(PasskeyError::Verify);
    }
    let client: ClientDataOwned =
        serde_json::from_slice(&assertion.client_data_json).map_err(|_| PasskeyError::Verify)?;
    if client.kind != "webauthn.get"
        || client.challenge != B64.encode(challenge)
        || client.origin != origin
    {
        return Err(PasskeyError::Verify);
    }
    let signature = Signature::from_der(&assertion.signature).map_err(|_| PasskeyError::Verify)?;
    key.verify(&signed_bytes(data, &assertion.client_data_json), &signature)
        .map_err(|_| PasskeyError::Verify)
}

/// Normalizes a website to a relying party id: `https://GitHub.com/login`
/// becomes `github.com`.
pub fn rp_id(website: &str) -> Result<String> {
    let s = website.trim().to_ascii_lowercase();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(&s);
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    let valid = !host.is_empty()
        && host.len() <= MAX_RP_ID
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    if !valid {
        return Err(PasskeyError::InvalidWebsite);
    }
    Ok(host.to_owned())
}

fn user(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_USER_NAME {
        return Err(PasskeyError::MissingUser);
    }
    Ok(name.to_owned())
}

/// Canonical base64url (no padding) of 1..=max bytes. Accepts standard
/// base64 and padding, as exports vary.
fn base64url(s: &str, max: usize) -> Option<String> {
    let cleaned: String = s
        .trim()
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    let bytes = B64.decode(cleaned).ok()?;
    (!bytes.is_empty() && bytes.len() <= max).then(|| B64.encode(bytes))
}

fn parse_private_key(input: &str) -> Result<SigningKey> {
    let input = input.trim();
    if input.starts_with("-----BEGIN") {
        return SigningKey::from_pkcs8_pem(input).map_err(|_| PasskeyError::InvalidPrivateKey);
    }
    let compact: Zeroizing<String> = Zeroizing::new(input.split_whitespace().collect());
    let b64 = base64url(&compact, 4096).ok_or(PasskeyError::InvalidPrivateKey)?;
    let der = Zeroizing::new(
        B64.decode(b64)
            .map_err(|_| PasskeyError::InvalidPrivateKey)?,
    );
    SigningKey::from_pkcs8_der(&der).map_err(|_| PasskeyError::InvalidPrivateKey)
}

fn random_signing_key() -> Result<SigningKey> {
    // A random 32-byte string is a valid P-256 scalar except with
    // negligible probability; retry in that case.
    for _ in 0..8 {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| PasskeyError::Random)?;
        if let Ok(key) = SigningKey::from_bytes(bytes.as_ref().into()) {
            return Ok(key);
        }
    }
    Err(PasskeyError::Random)
}

fn encode_key(key: &SigningKey) -> Result<String> {
    let der = key
        .to_pkcs8_der()
        .map_err(|_| PasskeyError::InvalidPrivateKey)?;
    Ok(B64.encode(der.as_bytes()))
}

fn signed_bytes(authenticator_data: &[u8], client_data_json: &[u8]) -> Vec<u8> {
    let mut msg = authenticator_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data_json));
    msg
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientData<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    challenge: &'a str,
    origin: &'a str,
    cross_origin: bool,
}

#[derive(Deserialize)]
struct ClientDataOwned {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000;

    #[test]
    fn normalizes_websites() {
        assert_eq!(rp_id("github.com").unwrap(), "github.com");
        assert_eq!(rp_id(" https://GitHub.com/login ").unwrap(), "github.com");
        assert_eq!(rp_id("http://localhost:8080/x").unwrap(), "localhost");
        assert_eq!(rp_id("login.example.co.uk").unwrap(), "login.example.co.uk");
        for bad in ["", "https://", "exa mple.com", "-a.com", "a..com", "é.com"] {
            assert_eq!(rp_id(bad), Err(PasskeyError::InvalidWebsite), "{bad}");
        }
    }

    #[test]
    fn generated_passkeys_sign_and_verify() {
        let pk = Passkey::generate("https://github.com", " octocat ", NOW).unwrap();
        assert_eq!(pk.rp_id, "github.com");
        assert_eq!(pk.user_name, "octocat");
        assert_eq!(B64.decode(&pk.credential_id).unwrap().len(), 16);
        pk.validate().unwrap();
        pk.self_test().unwrap();

        let challenge = b"server challenge";
        let a = pk.sign_assertion(challenge, "https://github.com").unwrap();
        let public = pk.public_key().unwrap();
        verify_assertion(&public, "github.com", "https://github.com", challenge, &a).unwrap();

        // A different site, origin, challenge or key must not verify.
        let other = Passkey::generate("github.com", "octocat", NOW).unwrap();
        assert!(
            verify_assertion(&public, "gitlab.com", "https://github.com", challenge, &a).is_err()
        );
        assert!(
            verify_assertion(&public, "github.com", "https://evil.com", challenge, &a).is_err()
        );
        assert!(
            verify_assertion(&public, "github.com", "https://github.com", b"other", &a).is_err()
        );
        assert!(
            verify_assertion(
                &other.public_key().unwrap(),
                "github.com",
                "https://github.com",
                challenge,
                &a
            )
            .is_err()
        );
        let mut tampered = a.clone();
        tampered.authenticator_data[33] ^= 1;
        assert!(
            verify_assertion(
                &public,
                "github.com",
                "https://github.com",
                challenge,
                &tampered
            )
            .is_err()
        );
    }

    #[test]
    fn imports_from_pem_and_base64() {
        let original = Passkey::generate("example.com", "alice", NOW).unwrap();
        let pem = original.private_key_pem().unwrap();
        let imported = Passkey::import(
            "example.com",
            "alice",
            &original.credential_id,
            &original.user_handle,
            &pem,
            NOW,
        )
        .unwrap();
        assert_eq!(imported.public_key(), original.public_key());
        assert_eq!(imported.credential_id, original.credential_id);

        // Standard base64 with padding, split over lines, works too.
        let std_b64 = base64::engine::general_purpose::STANDARD
            .encode(B64.decode(&original.private_key).unwrap());
        let wrapped = format!("{}\n{}", &std_b64[..40], &std_b64[40..]);
        let from_b64 = Passkey::import("example.com", "alice", "AAEC", "", &wrapped, NOW).unwrap();
        assert_eq!(from_b64.public_key(), original.public_key());
        assert_eq!(from_b64.credential_id, "AAEC");
        assert!(!from_b64.user_handle.is_empty());
    }

    #[test]
    fn rejects_bad_imports() {
        let pk = Passkey::generate("example.com", "alice", NOW).unwrap();
        let pem = pk.private_key_pem().unwrap();
        assert_eq!(
            Passkey::import("example.com", "alice", "", "", &pem, NOW),
            Err(PasskeyError::InvalidCredentialId)
        );
        assert_eq!(
            Passkey::import("example.com", "alice", "AAEC", "", "not a key", NOW),
            Err(PasskeyError::InvalidPrivateKey)
        );
        assert_eq!(
            Passkey::import("example.com", " ", "AAEC", "", &pem, NOW),
            Err(PasskeyError::MissingUser)
        );
    }

    #[test]
    fn round_trips_through_json_and_hides_the_key_in_debug() {
        let pk = Passkey::generate("example.com", "alice", NOW).unwrap();
        let json = serde_json::to_string(&pk).unwrap();
        let back: Passkey = serde_json::from_str(&json).unwrap();
        assert_eq!(back, pk);
        assert!(json.contains("\"privateKey\""));
        assert!(!format!("{pk:?}").contains(&pk.private_key));

        let mut damaged = back.clone();
        damaged.private_key = "AAAA".into();
        assert_eq!(damaged.validate(), Err(PasskeyError::Damaged));
    }
}

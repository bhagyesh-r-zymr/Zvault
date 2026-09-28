//! SSH keys kept inside vault items, like 1Password's SSH Key item. The
//! private key is stored, encrypted, in the item as an unencrypted OpenSSH
//! private key and used only here, on the device: to show its public key and
//! fingerprint, and to sign for the SSH agent the desktop app serves.
//!
//! New keys are Ed25519. Imports take OpenSSH private keys (`BEGIN OPENSSH
//! PRIVATE KEY`, passphrase-protected or not) of type Ed25519, ECDSA P-256 or
//! P-384, or RSA of at least 2048 bits.
//!
//! [`agent`] is the SSH agent wire protocol, without any I/O policy.

use rsa::signature::SignatureEncoding;
use serde::{Deserialize, Serialize};
use ssh_encoding::Encode;
use ssh_key::private::KeypairData;
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, EcdsaCurve, HashAlg, LineEnding, PrivateKey};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub mod agent;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SshKeyError {
    #[error("Paste an OpenSSH private key (it starts with -----BEGIN OPENSSH PRIVATE KEY-----).")]
    InvalidPrivateKey,
    #[error("This key is protected by a passphrase. Enter it to import the key.")]
    NeedsPassphrase,
    #[error("That passphrase did not unlock the key.")]
    WrongPassphrase,
    #[error("Zvault supports Ed25519, ECDSA (P-256, P-384) and RSA (2048 bits or more) keys.")]
    Unsupported,
    #[error("The key name can be at most 256 characters.")]
    CommentTooLong,
    #[error("This SSH key is damaged.")]
    Damaged,
    #[error("Could not create an SSH key.")]
    Random,
    #[error("Could not sign with this SSH key.")]
    Sign,
}

pub type Result<T> = core::result::Result<T, SshKeyError>;

/// Longest private key accepted for import (a 16384-bit RSA key is ~12 KB).
const MAX_PRIVATE_KEY: usize = 16 * 1024;
const MAX_COMMENT: usize = 256;
const MIN_RSA_BITS: usize = 2048;

/// A stored SSH key. `private_key` is an unencrypted OpenSSH private key
/// (the item it lives in is encrypted) and is wiped on drop. The key's
/// comment is kept inside it, as OpenSSH does.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    private_key: String,
    /// When the key was created or imported, in Unix seconds.
    #[zeroize(skip)]
    pub created_at: i64,
}

impl std::fmt::Debug for SshKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshKey")
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

impl SshKey {
    /// Creates a new Ed25519 key.
    pub fn generate(comment: &str, now: i64) -> Result<Self> {
        let mut key =
            PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(|_| SshKeyError::Random)?;
        key.set_comment(clean_comment(comment)?);
        Self::from_key(&key, now)
    }

    /// Imports an OpenSSH private key. `passphrase` unlocks an encrypted
    /// one; the stored copy is never encrypted with it. An empty `comment`
    /// keeps the key's own.
    pub fn import(pem: &str, passphrase: &str, comment: &str, now: i64) -> Result<Self> {
        let pem = pem.trim();
        if pem.is_empty() || pem.len() > MAX_PRIVATE_KEY {
            return Err(SshKeyError::InvalidPrivateKey);
        }
        let parsed = PrivateKey::from_openssh(pem).map_err(|_| SshKeyError::InvalidPrivateKey)?;
        let mut key = if parsed.is_encrypted() {
            if passphrase.is_empty() {
                return Err(SshKeyError::NeedsPassphrase);
            }
            parsed
                .decrypt(passphrase)
                .map_err(|_| SshKeyError::WrongPassphrase)?
        } else {
            parsed
        };
        check_supported(&key)?;
        let comment = clean_comment(comment)?;
        if !comment.is_empty() {
            key.set_comment(comment);
        }
        Self::from_key(&key, now)
    }

    fn from_key(key: &PrivateKey, now: i64) -> Result<Self> {
        let pem = key
            .to_openssh(LineEnding::LF)
            .map_err(|_| SshKeyError::Damaged)?;
        Ok(Self {
            private_key: pem.to_string(),
            created_at: now,
        })
    }

    /// Checks a stored key still parses and is a supported type.
    pub fn validate(&self) -> Result<()> {
        self.key().map(|_| ())
    }

    fn key(&self) -> Result<PrivateKey> {
        let key =
            PrivateKey::from_openssh(&self.private_key).map_err(|_| SshKeyError::Damaged)?;
        if key.is_encrypted() {
            return Err(SshKeyError::Damaged);
        }
        check_supported(&key).map_err(|_| SshKeyError::Damaged)?;
        Ok(key)
    }

    /// Renames the key: its comment, shown by `ssh-add -l` and appended to
    /// the public key.
    pub fn set_comment(&mut self, comment: &str) -> Result<()> {
        let mut key = self.key()?;
        key.set_comment(clean_comment(comment)?);
        let pem = key
            .to_openssh(LineEnding::LF)
            .map_err(|_| SshKeyError::Damaged)?;
        self.private_key.zeroize();
        self.private_key = pem.to_string();
        Ok(())
    }

    /// The public details the UI shows. Holds no secret.
    pub fn public(&self) -> Result<SshPublicKey> {
        let key = self.key()?;
        let public = key.public_key();
        Ok(SshPublicKey {
            public_key: public
                .to_openssh()
                .map_err(|_| SshKeyError::Damaged)?,
            fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
            key_type: key_type(&key),
            comment: key.comment().to_owned(),
            blob: key_blob(&key)?,
        })
    }

    /// The private key in OpenSSH format, for the user to export.
    pub fn private_key_openssh(&self) -> Zeroizing<String> {
        Zeroizing::new(self.private_key.clone())
    }

    /// Signs `data` as the SSH agent protocol asks (`SSH2_AGENTC_SIGN_REQUEST`)
    /// and returns the signature in SSH wire format. `flags` choose the RSA
    /// hash; RSA with SHA-1 (`ssh-rsa`) is refused.
    pub fn sign(&self, data: &[u8], flags: u32) -> Result<Vec<u8>> {
        let key = self.key()?;
        let signature = match key.key_data() {
            KeypairData::Rsa(rsa_key) => {
                let private = rsa_private_key(rsa_key)?;
                if flags & agent::SSH_AGENT_RSA_SHA2_512 != 0 {
                    rsa_signature::<sha2::Sha512>(private, data, HashAlg::Sha512)?
                } else if flags & agent::SSH_AGENT_RSA_SHA2_256 != 0 {
                    rsa_signature::<sha2::Sha256>(private, data, HashAlg::Sha256)?
                } else {
                    return Err(SshKeyError::Sign);
                }
            }
            _ => {
                use rsa::signature::Signer as _;
                key.key_data()
                    .try_sign(data)
                    .map_err(|_| SshKeyError::Sign)?
            }
        };
        let mut out = Vec::new();
        signature.encode(&mut out).map_err(|_| SshKeyError::Sign)?;
        Ok(out)
    }
}

/// `ssh-key`'s own conversion passes `p` twice instead of `p` and `q`, which
/// the `rsa` crate rejects, so the key is rebuilt here.
fn rsa_private_key(key: &ssh_key::private::RsaKeypair) -> Result<rsa::RsaPrivateKey> {
    let int = |m: &ssh_key::Mpint| {
        m.as_positive_bytes()
            .map(rsa::BigUint::from_bytes_be)
            .ok_or(SshKeyError::Sign)
    };
    rsa::RsaPrivateKey::from_components(
        int(&key.public.n)?,
        int(&key.public.e)?,
        int(&key.private.d)?,
        vec![int(&key.private.p)?, int(&key.private.q)?],
    )
    .map_err(|_| SshKeyError::Sign)
}

fn rsa_signature<D>(
    private: rsa::RsaPrivateKey,
    data: &[u8],
    hash: HashAlg,
) -> Result<ssh_key::Signature>
where
    D: sha2::Digest + rsa::pkcs8::AssociatedOid,
{
    use rsa::signature::Signer;
    let signing = rsa::pkcs1v15::SigningKey::<D>::new(private);
    let sig = signing.try_sign(data).map_err(|_| SshKeyError::Sign)?;
    ssh_key::Signature::new(Algorithm::Rsa { hash: Some(hash) }, sig.to_vec())
        .map_err(|_| SshKeyError::Sign)
}

/// What the UI and the agent show for a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPublicKey {
    /// One `authorized_keys` line: `ssh-ed25519 AAAA… comment`.
    pub public_key: String,
    /// `SHA256:…`, as `ssh-keygen -l` prints it.
    pub fingerprint: String,
    /// Such as `Ed25519`, `ECDSA P-256` or `RSA 4096`.
    pub key_type: String,
    pub comment: String,
    /// The public key in SSH wire format, as the agent protocol lists it.
    pub blob: Vec<u8>,
}

fn clean_comment(comment: &str) -> Result<String> {
    let c: String = comment
        .trim()
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    if c.chars().count() > MAX_COMMENT {
        return Err(SshKeyError::CommentTooLong);
    }
    Ok(c)
}

fn check_supported(key: &PrivateKey) -> Result<()> {
    match key.key_data() {
        KeypairData::Ed25519(_) => Ok(()),
        KeypairData::Ecdsa(k) if matches!(k.curve(), EcdsaCurve::NistP256 | EcdsaCurve::NistP384) => {
            Ok(())
        }
        KeypairData::Rsa(k) if rsa_bits(&k.public) >= MIN_RSA_BITS => Ok(()),
        _ => Err(SshKeyError::Unsupported),
    }
}

fn rsa_bits(public: &ssh_key::public::RsaPublicKey) -> usize {
    public
        .n
        .as_positive_bytes()
        .map_or(0, |n| n.len() * 8)
}

fn key_type(key: &PrivateKey) -> String {
    match key.key_data() {
        KeypairData::Ed25519(_) => "Ed25519".into(),
        KeypairData::Ecdsa(k) => match k.curve() {
            EcdsaCurve::NistP256 => "ECDSA P-256".into(),
            EcdsaCurve::NistP384 => "ECDSA P-384".into(),
            EcdsaCurve::NistP521 => "ECDSA P-521".into(),
        },
        KeypairData::Rsa(k) => format!("RSA {}", rsa_bits(&k.public)),
        _ => "SSH".into(),
    }
}

fn key_blob(key: &PrivateKey) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    key.public_key()
        .key_data()
        .encode(&mut out)
        .map_err(|_| SshKeyError::Damaged)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use ssh_key::{PublicKey, Signature, SshSig};

    use super::*;

    fn verify(key: &SshKey, data: &[u8], sig: &[u8]) {
        use ssh_encoding::Decode;
        use rsa::signature::Verifier;
        let public = PublicKey::from_openssh(&key.public().unwrap().public_key).unwrap();
        let sig = Signature::decode(&mut &sig[..]).unwrap();
        public.key_data().verify(data, &sig).unwrap();
    }

    #[test]
    fn generates_an_ed25519_key_and_signs() {
        let key = SshKey::generate("  work laptop\n", 42).unwrap();
        let public = key.public().unwrap();
        assert!(public.public_key.starts_with("ssh-ed25519 AAAA"));
        assert!(public.public_key.ends_with(" work laptop"));
        assert!(public.fingerprint.starts_with("SHA256:"));
        assert_eq!(public.key_type, "Ed25519");
        assert_eq!(public.comment, "work laptop");
        // string "ssh-ed25519" + string of 32 bytes
        assert_eq!(public.blob.len(), 4 + 11 + 4 + 32);
        let sig = key.sign(b"hello", 0).unwrap();
        verify(&key, b"hello", &sig);
        assert_eq!(key.created_at, 42);
        // The stored form survives JSON and never prints the key.
        let json = serde_json::to_string(&key).unwrap();
        let back: SshKey = serde_json::from_str(&json).unwrap();
        assert_eq!(back.public().unwrap(), public);
        assert!(!format!("{key:?}").contains("PRIVATE"));
    }

    #[test]
    fn imports_keeps_and_renames() {
        let source = SshKey::generate("old name", 0).unwrap();
        let pem = source.private_key_openssh();
        let imported = SshKey::import(&pem, "", "", 7).unwrap();
        assert_eq!(imported.public().unwrap().fingerprint, source.public().unwrap().fingerprint);
        assert_eq!(imported.public().unwrap().comment, "old name");
        let mut renamed = SshKey::import(&pem, "", "GitHub", 7).unwrap();
        assert_eq!(renamed.public().unwrap().comment, "GitHub");
        renamed.set_comment("Deploy").unwrap();
        assert_eq!(renamed.public().unwrap().comment, "Deploy");
        assert_eq!(renamed.public().unwrap().fingerprint, source.public().unwrap().fingerprint);
    }

    #[test]
    fn imports_a_passphrase_protected_key() {
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let encrypted = key.encrypt(&mut OsRng, "hunter2").unwrap();
        let pem = encrypted.to_openssh(LineEnding::LF).unwrap();
        assert_eq!(
            SshKey::import(&pem, "", "", 0).unwrap_err(),
            SshKeyError::NeedsPassphrase
        );
        assert_eq!(
            SshKey::import(&pem, "nope", "", 0).unwrap_err(),
            SshKeyError::WrongPassphrase
        );
        let imported = SshKey::import(&pem, "hunter2", "", 0).unwrap();
        // Stored without the passphrase.
        assert!(!PrivateKey::from_openssh(&*imported.private_key_openssh())
            .unwrap()
            .is_encrypted());
        assert_eq!(
            imported.public().unwrap().fingerprint,
            key.fingerprint(HashAlg::Sha256).to_string()
        );
    }

    #[test]
    fn signs_with_ecdsa() {
        let key = PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let imported = SshKey::import(&pem, "", "", 0).unwrap();
        assert_eq!(imported.public().unwrap().key_type, "ECDSA P-256");
        let sig = imported.sign(b"data", 0).unwrap();
        verify(&imported, b"data", &sig);
    }

    #[test]
    fn signs_with_rsa_sha2_only() {
        let rsa_key = ssh_key::private::RsaKeypair::random(&mut OsRng, 2048).unwrap();
        let key = PrivateKey::new(KeypairData::Rsa(rsa_key), "").unwrap();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let imported = SshKey::import(&pem, "", "", 0).unwrap();
        assert!(imported.public().unwrap().key_type.starts_with("RSA "));
        assert_eq!(imported.sign(b"x", 0).unwrap_err(), SshKeyError::Sign);
        for flag in [agent::SSH_AGENT_RSA_SHA2_256, agent::SSH_AGENT_RSA_SHA2_512] {
            let sig = imported.sign(b"x", flag).unwrap();
            verify(&imported, b"x", &sig);
        }
    }

    #[test]
    fn git_can_verify_an_sshsig_made_through_the_agent_path() {
        // git signs commits by asking the agent to sign an SSHSIG blob.
        let key = SshKey::generate("git", 0).unwrap();
        let public = PublicKey::from_openssh(&key.public().unwrap().public_key).unwrap();
        let signed = SshSig::signed_data("git", HashAlg::Sha512, b"tree 123\n").unwrap();
        let sig = key.sign(&signed, 0).unwrap();
        use ssh_encoding::Decode;
        let sig = Signature::decode(&mut &sig[..]).unwrap();
        let sshsig = SshSig::new(public.key_data().clone(), "git", HashAlg::Sha512, sig).unwrap();
        public.verify("git", b"tree 123\n", &sshsig).unwrap();
    }

    #[test]
    fn refuses_junk_and_damage() {
        assert_eq!(
            SshKey::import("ssh-ed25519 AAAA", "", "", 0).unwrap_err(),
            SshKeyError::InvalidPrivateKey
        );
        assert_eq!(
            SshKey::generate(&"x".repeat(300), 0).unwrap_err(),
            SshKeyError::CommentTooLong
        );
        let damaged: SshKey =
            serde_json::from_str(r#"{"privateKey":"nope","createdAt":0}"#).unwrap();
        assert_eq!(damaged.validate().unwrap_err(), SshKeyError::Damaged);
    }
}

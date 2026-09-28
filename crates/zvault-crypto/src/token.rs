//! Access tokens for cloud agents and CI.
//!
//! A token lets a machine that has no Zvault app (a CI runner, a cloud AI
//! agent) read one environment of one project. It is made on a device that
//! holds the keys, and it is itself the key:
//!
//! ```text
//! token secret ──HKDF──► auth key ──SHA-256──► verifier (stored by the server)
//!              └─HKDF──► wrap key ──wraps──► project key, environment key(s)
//! ```
//!
//! The server stores the verifier and the wrapped keys. When `zv` presents
//! the auth key the server checks it against the verifier and hands back the
//! wrapped keys and the project's ciphertext; `zv` unwraps and decrypts
//! locally. The server never sees the token secret or the wrap key, so it
//! still can't read anything. Like share links, the auth key proves the token
//! without revealing the wrap key.
//!
//! Wraps are bound to the token id, the project, the environment and its key
//! version, so the server can't hand one token's wrap to another or replay
//! a key from before a rotation.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::project::aad as project_aad;
use crate::vault::{unwrap_key, wrap_key};
use crate::{Error, KEY_LEN, Result, Sealed, SymmetricKey, random};

/// Token ids are UUIDs chosen on the issuing device: 16 bytes.
pub const TOKEN_ID_LEN: usize = 16;
/// Every token string starts with this, so secret scanners can spot one.
pub const TOKEN_PREFIX: &str = "zvt_";

const AUTH_INFO: &[u8] = b"zvault/v1/agent-token/auth";
const WRAP_INFO: &[u8] = b"zvault/v1/agent-token/wrap";

/// An access token: its public id plus the secret only the holder knows.
pub struct AgentToken {
    pub id: [u8; TOKEN_ID_LEN],
    secret: SymmetricKey,
}

impl AgentToken {
    /// A new token with a random id (a v4 UUID) and secret.
    pub fn generate() -> Result<Self> {
        let mut id: [u8; TOKEN_ID_LEN] = random::array()?;
        // Version 4, RFC 4122 variant, so the id is a valid UUID.
        id[6] = (id[6] & 0x0f) | 0x40;
        id[8] = (id[8] & 0x3f) | 0x80;
        Ok(Self {
            id,
            secret: SymmetricKey::generate()?,
        })
    }

    /// The token as the user copies it: `zvt_` and the id and secret in
    /// base64url. Treat as secret.
    pub fn encode(&self) -> Zeroizing<String> {
        let mut raw = Zeroizing::new([0u8; TOKEN_ID_LEN + KEY_LEN]);
        raw[..TOKEN_ID_LEN].copy_from_slice(&self.id);
        raw[TOKEN_ID_LEN..].copy_from_slice(self.secret.as_bytes());
        Zeroizing::new(format!("{TOKEN_PREFIX}{}", B64.encode(raw.as_ref())))
    }

    /// Parses a token string, ignoring surrounding whitespace.
    pub fn decode(s: &str) -> Result<Self> {
        let body = s
            .trim()
            .strip_prefix(TOKEN_PREFIX)
            .ok_or(Error::InvalidToken)?;
        let raw = Zeroizing::new(B64.decode(body).map_err(|_| Error::InvalidToken)?);
        if raw.len() != TOKEN_ID_LEN + KEY_LEN {
            return Err(Error::InvalidToken);
        }
        let mut id = [0u8; TOKEN_ID_LEN];
        id.copy_from_slice(&raw[..TOKEN_ID_LEN]);
        let mut secret = Zeroizing::new([0u8; KEY_LEN]);
        secret.copy_from_slice(&raw[TOKEN_ID_LEN..]);
        Ok(Self {
            id,
            secret: SymmetricKey::from_bytes(*secret),
        })
    }

    /// The id as the API stores it: a lowercase hyphenated UUID.
    pub fn id_string(&self) -> String {
        let h: String = self.id.iter().map(|b| format!("{b:02x}")).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &h[0..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32]
        )
    }

    fn derive(&self, info: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        Hkdf::<Sha256>::new(Some(&self.id), self.secret.as_bytes())
            .expand(info, out.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }

    /// Proves the token to the server. Sent on every request, never stored.
    pub fn auth_key(&self) -> Zeroizing<[u8; KEY_LEN]> {
        self.derive(AUTH_INFO)
    }

    /// What the server stores to check [`auth_key`](Self::auth_key). Safe to send.
    pub fn verifier(&self) -> [u8; 32] {
        Sha256::digest(self.auth_key().as_ref()).into()
    }

    fn wrap_key(&self) -> SymmetricKey {
        SymmetricKey::from_bytes(*self.derive(WRAP_INFO))
    }

    /// Wraps the project key (it opens names and other metadata) for this token.
    pub fn wrap_project_key(&self, project_id: &str, key: &SymmetricKey) -> Result<Sealed> {
        wrap_key(&self.wrap_key(), key, &self.project_aad(project_id))
    }

    pub fn unwrap_project_key(&self, project_id: &str, wrapped: &Sealed) -> Result<SymmetricKey> {
        unwrap_key(&self.wrap_key(), wrapped, &self.project_aad(project_id))
    }

    /// Wraps an environment key at `key_version` for this token.
    pub fn wrap_environment_key(
        &self,
        project_id: &str,
        environment_id: &str,
        key_version: u32,
        key: &SymmetricKey,
    ) -> Result<Sealed> {
        wrap_key(
            &self.wrap_key(),
            key,
            &self.environment_aad(project_id, environment_id, key_version),
        )
    }

    pub fn unwrap_environment_key(
        &self,
        project_id: &str,
        environment_id: &str,
        key_version: u32,
        wrapped: &Sealed,
    ) -> Result<SymmetricKey> {
        unwrap_key(
            &self.wrap_key(),
            wrapped,
            &self.environment_aad(project_id, environment_id, key_version),
        )
    }

    fn project_aad(&self, project_id: &str) -> Vec<u8> {
        let mut out = format!("zvault/v1/agent-token|{}|", self.id_string()).into_bytes();
        out.extend(project_aad::project_key(project_id));
        out
    }

    fn environment_aad(&self, project_id: &str, environment_id: &str, version: u32) -> Vec<u8> {
        let mut out = format!("zvault/v1/agent-token|{}|", self.id_string()).into_bytes();
        out.extend(project_aad::environment_key(project_id, environment_id));
        out.extend(format!("|v{version}").into_bytes());
        out
    }
}

/// `SHA-256(auth key)` for a presented auth key, as the server computes it.
pub fn token_verifier(auth_key: &[u8]) -> [u8; 32] {
    Sha256::digest(auth_key).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d";
    const DEV: &str = "1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e";
    const PROD: &str = "2d7c6e5a-7f3b-4c4d-8e9f-8a7b6c5d4e3f";

    #[test]
    fn encodes_and_decodes() {
        let token = AgentToken::generate().unwrap();
        let s = token.encode();
        assert!(s.starts_with("zvt_"));
        assert_eq!(s.len(), 4 + 64);
        let back = AgentToken::decode(&format!("  {}\n", s.as_str())).unwrap();
        assert_eq!(back.id, token.id);
        assert_eq!(back.verifier(), token.verifier());
        assert_eq!(back.id_string(), token.id_string());
        assert_eq!(token.id_string().len(), 36);
        assert_eq!(&token.id_string()[14..15], "4");
    }

    #[test]
    fn rejects_malformed_tokens() {
        for bad in [
            "",
            "zvt_",
            "zvs_AAAA",
            "zvt_!!!!",
            &format!("zvt_{}", "A".repeat(63)),
        ] {
            assert!(matches!(AgentToken::decode(bad), Err(Error::InvalidToken)));
        }
    }

    #[test]
    fn verifier_is_the_hash_of_the_auth_key_and_hides_the_wrap_key() {
        let token = AgentToken::generate().unwrap();
        assert_eq!(token.verifier(), token_verifier(token.auth_key().as_ref()));
        assert_ne!(token.auth_key().as_ref(), token.wrap_key().as_bytes());
    }

    #[test]
    fn wraps_open_only_for_their_token_environment_and_version() {
        let token = AgentToken::generate().unwrap();
        let other = AgentToken::generate().unwrap();
        let env = SymmetricKey::generate().unwrap();
        let wrapped = token.wrap_environment_key(P, DEV, 2, &env).unwrap();
        assert_eq!(
            token
                .unwrap_environment_key(P, DEV, 2, &wrapped)
                .unwrap()
                .as_bytes(),
            env.as_bytes()
        );
        assert!(token.unwrap_environment_key(P, PROD, 2, &wrapped).is_err());
        assert!(token.unwrap_environment_key(P, DEV, 1, &wrapped).is_err());
        assert!(token.unwrap_project_key(P, &wrapped).is_err());
        assert!(other.unwrap_environment_key(P, DEV, 2, &wrapped).is_err());

        let project = SymmetricKey::generate().unwrap();
        let wrapped = token.wrap_project_key(P, &project).unwrap();
        assert_eq!(
            token.unwrap_project_key(P, &wrapped).unwrap().as_bytes(),
            project.as_bytes()
        );
        assert!(other.unwrap_project_key(P, &wrapped).is_err());
        assert!(token.unwrap_project_key(DEV, &wrapped).is_err());
    }
}

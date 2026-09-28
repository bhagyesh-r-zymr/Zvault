//! Access tokens for cloud agents and CI (`ZVAULT_TOKEN`).
//!
//! [`agent_token_issue`] makes a token on this device: it wraps the project
//! key and the chosen environment keys (held here since the project was
//! opened) with a key derived from the new token, and returns the body for
//! `POST /v1/projects/:id/tokens` plus the token itself, which the UI shows
//! once. The server gets the verifier and the wraps, never the token.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use zvault_crypto::AgentToken;

use crate::vault::{Blob, Keyring, VaultError, canonical_id};

type Result<T> = core::result::Result<T, VaultError>;

/// `kid` of a key wrapped for a token. Matches `TOKEN_KID` in `@zvault/shared`.
const TOKEN_KID: &str = "agent-token";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEnvironment {
    pub environment_id: String,
    pub key_version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEnvironmentKey {
    pub environment_id: String,
    pub key_version: u32,
    pub encrypted_key: Blob,
}

/// A new token: the API body's key material, and the token to show once.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedToken {
    pub id: String,
    pub verifier: String,
    pub encrypted_project_key: Blob,
    pub environments: Vec<TokenEnvironmentKey>,
    /// `zvt_…`. Shown to the person once; never sent to the API.
    pub token: String,
}

impl Keyring {
    /// Makes a token for `environments` of a project (the one it reads first,
    /// then the ones it falls back to). Needs every key to be open here.
    pub fn issue_agent_token(
        &self,
        project_id: &str,
        environments: &[TokenEnvironment],
    ) -> Result<IssuedToken> {
        let project_id = canonical_id(project_id)?;
        if environments.is_empty() {
            return Err(VaultError::InvalidRecord);
        }
        let token = AgentToken::generate().map_err(|_| VaultError::Encrypt)?;
        self.with_project_keys(|_, keys| {
            let wrapped = token
                .wrap_project_key(&project_id, keys.project(&project_id)?)
                .map_err(|_| VaultError::Encrypt)?;
            let mut envs = Vec::with_capacity(environments.len());
            for env in environments {
                let env_id = canonical_id(&env.environment_id)?;
                let sealed = token
                    .wrap_environment_key(
                        &project_id,
                        &env_id,
                        env.key_version,
                        keys.environment(&project_id, &env_id)?,
                    )
                    .map_err(|_| VaultError::Encrypt)?;
                envs.push(TokenEnvironmentKey {
                    environment_id: env_id,
                    key_version: env.key_version,
                    encrypted_key: Blob::new(TOKEN_KID, &sealed),
                });
            }
            Ok(IssuedToken {
                id: token.id_string(),
                verifier: B64.encode(token.verifier()),
                encrypted_project_key: Blob::new(TOKEN_KID, &wrapped),
                environments: envs,
                token: token.encode().to_string(),
            })
        })
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_token_issue(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    environments: Vec<TokenEnvironment>,
) -> Result<IssuedToken> {
    keyring.issue_agent_token(&project_id, &environments)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zvault_crypto::SymmetricKey;
    use zvault_crypto::project::aad;
    use zvault_crypto::vault::open_padded;

    use super::*;

    #[test]
    fn a_token_opens_only_the_keys_it_was_given() {
        let keyring = Keyring::default();
        keyring.unlock(SymmetricKey::generate().unwrap());
        let p = keyring
            .create_project(
                &json!({ "name": "Web", "slug": "web" }),
                &[
                    json!({ "name": "Development", "slug": "development", "kind": "development", "position": 0 }),
                    json!({ "name": "Production", "slug": "production", "kind": "production", "position": 1 }),
                ],
            )
            .unwrap();
        let (dev, prod) = (&p.environments[0].id, &p.environments[1].id);
        let secret = "5a0f9b8d-0c6e-4f70-b1c2-bd0e9f807162";
        let value = keyring
            .seal_secret_value(&p.id, secret, prod, "sk_live".into())
            .unwrap();

        let issued = keyring
            .issue_agent_token(
                &p.id,
                &[TokenEnvironment {
                    environment_id: prod.clone(),
                    key_version: 1,
                }],
            )
            .unwrap();
        assert!(issued.token.starts_with("zvt_"));
        assert_eq!(issued.environments.len(), 1);
        assert_eq!(issued.encrypted_project_key.kid, TOKEN_KID);

        let token = AgentToken::decode(&issued.token).unwrap();
        assert_eq!(token.id_string(), issued.id);
        assert_eq!(B64.encode(token.verifier()), issued.verifier);
        let env_key = token
            .unwrap_environment_key(
                &p.id,
                prod,
                1,
                &issued.environments[0]
                    .encrypted_key
                    .sealed(TOKEN_KID)
                    .unwrap(),
            )
            .unwrap();
        let json = open_padded(
            &env_key,
            &value.sealed(prod).unwrap(),
            &aad::secret_value(&p.id, secret, prod),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&json).contains("sk_live"));
        assert!(
            token
                .unwrap_environment_key(
                    &p.id,
                    dev,
                    1,
                    &issued.environments[0]
                        .encrypted_key
                        .sealed(TOKEN_KID)
                        .unwrap()
                )
                .is_err()
        );
    }

    #[test]
    fn needs_the_keys_open() {
        let keyring = Keyring::default();
        let env = [TokenEnvironment {
            environment_id: "1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e".into(),
            key_version: 1,
        }];
        assert_eq!(
            keyring
                .issue_agent_token("0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d", &env)
                .err(),
            Some(VaultError::Locked)
        );
    }
}

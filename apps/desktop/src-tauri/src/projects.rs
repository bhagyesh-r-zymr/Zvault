//! Project, environment, folder and secret commands.
//!
//! Keys live in the vault [`Keyring`] and are wiped with it on lock. The UI
//! sends plaintext metadata (the shapes of `ProjectMeta`, `EnvironmentMeta`,
//! `FolderMeta` and `SecretMeta` in `@zvault/shared`, which it validates) and
//! gets back blobs to relay to the API, and the reverse. Secret values are
//! only decrypted when the UI asks for one to reveal or copy.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use zeroize::Zeroizing;
use zvault_crypto::SymmetricKey;
use zvault_crypto::project::aad;
use zvault_crypto::vault::{open_padded, seal_padded, unwrap_key, wrap_key};

use crate::team::{MEMBER_KEY_WRAP_KID, StoredMemberWrap};
use crate::vault::{ACCOUNT_KID, Blob, Keyring, VaultError, canonical_id};

type Result<T> = core::result::Result<T, VaultError>;

/// Project and environment keys unwrapped this session.
#[derive(Default)]
pub struct ProjectKeys {
    pub(crate) projects: HashMap<String, SymmetricKey>,
    /// Keyed by (project id, environment id).
    pub(crate) environments: HashMap<(String, String), SymmetricKey>,
    /// New environment keys made by a rotation the API hasn't accepted yet.
    pub(crate) rotations: HashMap<(String, String), SymmetricKey>,
}

impl ProjectKeys {
    pub(crate) fn project(&self, project_id: &str) -> Result<&SymmetricKey> {
        self.projects
            .get(project_id)
            .ok_or(VaultError::VaultNotOpen)
    }

    pub(crate) fn environment(
        &self,
        project_id: &str,
        environment_id: &str,
    ) -> Result<&SymmetricKey> {
        self.environments
            .get(&(project_id.to_owned(), environment_id.to_owned()))
            .ok_or(VaultError::VaultNotOpen)
    }
}

/// A project as the API returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCipher {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_meta: Blob,
}

/// An environment as sealed here or returned by the API. `encrypted_key` is
/// the caller's grant: absent for environments they can't read values of.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCipher {
    pub id: String,
    pub encrypted_meta: Blob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_key: Option<Blob>,
}

/// The body of `POST /v1/projects`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_meta: Blob,
    pub environments: Vec<EnvironmentCipher>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentView {
    pub meta: Value,
    /// Whether this account holds the key, i.e. can read and write its values.
    pub unlocked: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Folder,
    Secret,
}

impl EntryKind {
    fn aad(self, project_id: &str, id: &str) -> Vec<u8> {
        match self {
            Self::Folder => aad::folder_meta(project_id, id),
            Self::Secret => aad::secret_meta(project_id, id),
        }
    }
}

/// A folder's or secret's sealed metadata and the id it is bound to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedEntry {
    pub id: String,
    pub encrypted_meta: Blob,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ValuePlaintext {
    pub(crate) value: String,
}

impl Drop for ValuePlaintext {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.value);
    }
}

pub(crate) fn new_key() -> Result<SymmetricKey> {
    SymmetricKey::generate().map_err(|_| VaultError::Encrypt)
}

fn seal_json(key: &SymmetricKey, value: &Value, aad: &[u8], kid: &str) -> Result<Blob> {
    if !value.is_object() {
        return Err(VaultError::InvalidRecord);
    }
    let json = Zeroizing::new(serde_json::to_vec(value).map_err(|_| VaultError::Encrypt)?);
    let sealed = seal_padded(key, &json, aad).map_err(|_| VaultError::Encrypt)?;
    Ok(Blob::new(kid, &sealed))
}

fn open_json(key: &SymmetricKey, blob: &Blob, aad: &[u8], kid: &str) -> Result<Value> {
    let json = open_padded(key, &blob.sealed(kid)?, aad).map_err(|_| VaultError::Decrypt)?;
    let value: Value = serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(VaultError::Decrypt)
    }
}

fn wrap_for_account(account: &SymmetricKey, key: &SymmetricKey, aad: &[u8]) -> Result<Blob> {
    let wrapped = wrap_key(account, key, aad).map_err(|_| VaultError::Encrypt)?;
    Ok(Blob::new(ACCOUNT_KID, &wrapped))
}

fn id_or_new(id: Option<&str>) -> Result<String> {
    id.map_or_else(|| Ok(Uuid::new_v4().to_string()), canonical_id)
}

impl Keyring {
    /// A new project with fresh keys and the given environments, ready to upload.
    pub fn create_project(&self, meta: &Value, environments: &[Value]) -> Result<NewProject> {
        self.with_project_keys(|account, keys| {
            let id = Uuid::new_v4().to_string();
            let project_key = new_key()?;
            let encrypted_key = wrap_for_account(account, &project_key, &aad::project_key(&id))?;
            let encrypted_meta = seal_json(&project_key, meta, &aad::project_meta(&id), &id)?;
            let mut sealed = Vec::with_capacity(environments.len());
            let mut env_keys = Vec::with_capacity(environments.len());
            for env_meta in environments {
                let env_id = Uuid::new_v4().to_string();
                let env_key = new_key()?;
                sealed.push(EnvironmentCipher {
                    encrypted_meta: seal_json(
                        &project_key,
                        env_meta,
                        &aad::environment_meta(&id, &env_id),
                        &env_id,
                    )?,
                    encrypted_key: Some(wrap_for_account(
                        account,
                        &env_key,
                        &aad::environment_key(&id, &env_id),
                    )?),
                    id: env_id.clone(),
                });
                env_keys.push((env_id, env_key));
            }
            for (env_id, env_key) in env_keys {
                keys.environments.insert((id.clone(), env_id), env_key);
            }
            keys.projects.insert(id.clone(), project_key);
            Ok(NewProject {
                id,
                encrypted_key,
                encrypted_meta,
                environments: sealed,
            })
        })
    }

    /// Unwraps a project's key and returns its metadata. `member_wrap` is the
    /// caller's wrap from `GET /access/projects/:id/keys/me`, for a project
    /// someone else shared; without one the key must be the account's own.
    pub fn open_project(
        &self,
        project: &ProjectCipher,
        member_wrap: Option<&StoredMemberWrap>,
    ) -> Result<Value> {
        let id = canonical_id(&project.id)?;
        self.with_project_keys(|account, keys| {
            let project_key = match member_wrap {
                Some(wrap) => wrap.unwrap_project_key(account, &id)?,
                None => unwrap_key(
                    account,
                    &project.encrypted_key.sealed(ACCOUNT_KID)?,
                    &aad::project_key(&id),
                )
                .map_err(|_| VaultError::Decrypt)?,
            };
            let meta = open_json(
                &project_key,
                &project.encrypted_meta,
                &aad::project_meta(&id),
                &id,
            )?;
            keys.projects.insert(id, project_key);
            Ok(meta)
        })
    }

    /// Returns an environment's metadata, and keeps its key if the account
    /// holds one: its own grant, or `member_wrap` for a shared environment.
    pub fn open_environment(
        &self,
        project_id: &str,
        env: &EnvironmentCipher,
        member_wrap: Option<&StoredMemberWrap>,
    ) -> Result<EnvironmentView> {
        let project_id = canonical_id(project_id)?;
        let env_id = canonical_id(&env.id)?;
        self.with_project_keys(|account, keys| {
            let meta = open_json(
                keys.project(&project_id)?,
                &env.encrypted_meta,
                &aad::environment_meta(&project_id, &env_id),
                &env_id,
            )?;
            let unlocked = match (member_wrap, &env.encrypted_key) {
                (Some(wrap), _) => {
                    let key = wrap.unwrap_environment_key(account, &project_id, &env_id)?;
                    keys.environments.insert((project_id, env_id), key);
                    true
                }
                // A member wrap served without its public halves can't be
                // opened; show the environment as locked.
                (None, Some(blob)) if blob.kid == MEMBER_KEY_WRAP_KID => false,
                (None, Some(blob)) => {
                    let key = unwrap_key(
                        account,
                        &blob.sealed(ACCOUNT_KID)?,
                        &aad::environment_key(&project_id, &env_id),
                    )
                    .map_err(|_| VaultError::Decrypt)?;
                    keys.environments.insert((project_id, env_id), key);
                    true
                }
                (None, None) => false,
            };
            Ok(EnvironmentView { meta, unlocked })
        })
    }

    /// Seals environment metadata. Without an id this creates an environment
    /// with a fresh key; with one it re-seals the metadata and keeps the key.
    pub fn seal_environment(
        &self,
        project_id: &str,
        id: Option<&str>,
        meta: &Value,
    ) -> Result<EnvironmentCipher> {
        let project_id = canonical_id(project_id)?;
        let env_id = id_or_new(id)?;
        self.with_project_keys(|account, keys| {
            let encrypted_meta = seal_json(
                keys.project(&project_id)?,
                meta,
                &aad::environment_meta(&project_id, &env_id),
                &env_id,
            )?;
            let encrypted_key = if id.is_none() {
                let env_key = new_key()?;
                let wrapped = wrap_for_account(
                    account,
                    &env_key,
                    &aad::environment_key(&project_id, &env_id),
                )?;
                keys.environments
                    .insert((project_id.clone(), env_id.clone()), env_key);
                Some(wrapped)
            } else {
                None
            };
            Ok(EnvironmentCipher {
                id: env_id,
                encrypted_meta,
                encrypted_key,
            })
        })
    }

    pub fn seal_entry(
        &self,
        project_id: &str,
        kind: EntryKind,
        id: Option<&str>,
        meta: &Value,
    ) -> Result<SealedEntry> {
        let project_id = canonical_id(project_id)?;
        let id = id_or_new(id)?;
        self.with_project_keys(|_, keys| {
            let encrypted_meta = seal_json(
                keys.project(&project_id)?,
                meta,
                &kind.aad(&project_id, &id),
                &id,
            )?;
            Ok(SealedEntry { id, encrypted_meta })
        })
    }

    pub fn open_entry(
        &self,
        project_id: &str,
        kind: EntryKind,
        id: &str,
        encrypted_meta: &Blob,
    ) -> Result<Value> {
        let project_id = canonical_id(project_id)?;
        let id = canonical_id(id)?;
        self.with_project_keys(|_, keys| {
            open_json(
                keys.project(&project_id)?,
                encrypted_meta,
                &kind.aad(&project_id, &id),
                &id,
            )
        })
    }

    pub fn seal_secret_value(
        &self,
        project_id: &str,
        secret_id: &str,
        environment_id: &str,
        value: String,
    ) -> Result<Blob> {
        let project_id = canonical_id(project_id)?;
        let secret_id = canonical_id(secret_id)?;
        let environment_id = canonical_id(environment_id)?;
        let plaintext = ValuePlaintext { value };
        self.with_project_keys(|_, keys| {
            let json =
                Zeroizing::new(serde_json::to_vec(&plaintext).map_err(|_| VaultError::Encrypt)?);
            let sealed = seal_padded(
                keys.environment(&project_id, &environment_id)?,
                &json,
                &aad::secret_value(&project_id, &secret_id, &environment_id),
            )
            .map_err(|_| VaultError::Encrypt)?;
            Ok(Blob::new(&environment_id, &sealed))
        })
    }

    pub fn open_secret_value(
        &self,
        project_id: &str,
        secret_id: &str,
        environment_id: &str,
        blob: &Blob,
    ) -> Result<Zeroizing<String>> {
        let project_id = canonical_id(project_id)?;
        let secret_id = canonical_id(secret_id)?;
        let environment_id = canonical_id(environment_id)?;
        self.with_project_keys(|_, keys| {
            let json = open_padded(
                keys.environment(&project_id, &environment_id)?,
                &blob.sealed(&environment_id)?,
                &aad::secret_value(&project_id, &secret_id, &environment_id),
            )
            .map_err(|_| VaultError::Decrypt)?;
            let mut plaintext: ValuePlaintext =
                serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)?;
            Ok(Zeroizing::new(std::mem::take(&mut plaintext.value)))
        })
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn project_create(
    keyring: tauri::State<'_, Keyring>,
    meta: Value,
    environments: Vec<Value>,
) -> Result<NewProject> {
    keyring.create_project(&meta, &environments)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn project_open(
    keyring: tauri::State<'_, Keyring>,
    project: ProjectCipher,
    member_wrap: Option<StoredMemberWrap>,
) -> Result<Value> {
    keyring.open_project(&project, member_wrap.as_ref())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn environment_open(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    environment: EnvironmentCipher,
    member_wrap: Option<StoredMemberWrap>,
) -> Result<EnvironmentView> {
    keyring.open_environment(&project_id, &environment, member_wrap.as_ref())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn environment_seal(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    id: Option<String>,
    meta: Value,
) -> Result<EnvironmentCipher> {
    keyring.seal_environment(&project_id, id.as_deref(), &meta)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn entry_seal(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    kind: EntryKind,
    id: Option<String>,
    meta: Value,
) -> Result<SealedEntry> {
    keyring.seal_entry(&project_id, kind, id.as_deref(), &meta)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn entry_open(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    kind: EntryKind,
    id: String,
    encrypted_meta: Blob,
) -> Result<Value> {
    keyring.open_entry(&project_id, kind, &id, &encrypted_meta)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_value_seal(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    secret_id: String,
    environment_id: String,
    value: String,
) -> Result<Blob> {
    keyring.seal_secret_value(&project_id, &secret_id, &environment_id, value)
}

/// Decrypts one value for the UI to show. Prefer `copy_secret` for copying.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_value_open(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    secret_id: String,
    environment_id: String,
    encrypted_value: Blob,
) -> Result<String> {
    keyring
        .open_secret_value(&project_id, &secret_id, &environment_id, &encrypted_value)
        .map(|v| v.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn unlocked() -> Keyring {
        let keyring = Keyring::default();
        keyring.unlock(SymmetricKey::generate().unwrap());
        keyring
    }

    fn project(keyring: &Keyring) -> NewProject {
        keyring
            .create_project(
                &json!({ "name": "Payments API", "slug": "payments-api" }),
                &[
                    json!({ "name": "Development", "slug": "development", "kind": "development", "position": 0 }),
                    json!({ "name": "Production", "slug": "production", "kind": "production", "position": 1 }),
                ],
            )
            .unwrap()
    }

    fn cipher(p: &NewProject) -> ProjectCipher {
        ProjectCipher {
            id: p.id.clone(),
            encrypted_key: p.encrypted_key.clone(),
            encrypted_meta: p.encrypted_meta.clone(),
        }
    }

    #[test]
    fn requires_an_unlocked_account() {
        let keyring = Keyring::default();
        assert_eq!(
            keyring.create_project(&json!({}), &[]).unwrap_err(),
            VaultError::Locked
        );
    }

    #[test]
    fn creates_a_project_and_reopens_it_after_lock() {
        let account = SymmetricKey::generate().unwrap();
        let bytes = *account.as_bytes();
        let keyring = Keyring::default();
        keyring.unlock(account);
        let p = project(&keyring);
        assert_eq!(p.encrypted_key.kid, "account");
        assert_eq!(p.encrypted_meta.kid, p.id);
        assert_eq!(p.environments.len(), 2);

        keyring.lock();
        keyring.unlock(SymmetricKey::from_bytes(bytes));
        let meta = keyring.open_project(&cipher(&p), None).unwrap();
        assert_eq!(meta["name"], "Payments API");
        let env = keyring
            .open_environment(&p.id, &p.environments[1], None)
            .unwrap();
        assert_eq!(env.meta["slug"], "production");
        assert!(env.unlocked);
    }

    #[test]
    fn seals_and_opens_secrets_per_environment() {
        let keyring = unlocked();
        let p = project(&keyring);
        let (dev, prod) = (&p.environments[0].id, &p.environments[1].id);
        let secret = keyring
            .seal_entry(
                &p.id,
                EntryKind::Secret,
                None,
                &json!({ "name": "Stripe", "key": "STRIPE_SECRET_KEY", "tags": ["payments"] }),
            )
            .unwrap();
        let meta = keyring
            .open_entry(&p.id, EntryKind::Secret, &secret.id, &secret.encrypted_meta)
            .unwrap();
        assert_eq!(meta["key"], "STRIPE_SECRET_KEY");
        // A secret's metadata can't be passed off as a folder's.
        assert!(
            keyring
                .open_entry(&p.id, EntryKind::Folder, &secret.id, &secret.encrypted_meta)
                .is_err()
        );

        let value = keyring
            .seal_secret_value(&p.id, &secret.id, prod, "sk_live_123".into())
            .unwrap();
        assert_eq!(value.kid, *prod);
        assert_eq!(
            keyring
                .open_secret_value(&p.id, &secret.id, prod, &value)
                .unwrap()
                .as_str(),
            "sk_live_123"
        );
        // Relabelled as the Development value, it no longer opens.
        let mut moved = value.clone();
        moved.kid.clone_from(dev);
        assert!(
            keyring
                .open_secret_value(&p.id, &secret.id, dev, &moved)
                .is_err()
        );
    }

    #[test]
    fn an_environment_without_a_grant_is_listed_but_locked() {
        let account = SymmetricKey::generate().unwrap();
        let bytes = *account.as_bytes();
        let keyring = Keyring::default();
        keyring.unlock(account);
        let p = project(&keyring);

        // Another session of a member who holds the project key but not Production's.
        let member = Keyring::default();
        member.unlock(SymmetricKey::from_bytes(bytes));
        member.open_project(&cipher(&p), None).unwrap();
        let mut prod = p.environments[1].clone();
        prod.encrypted_key = None;
        let view = member.open_environment(&p.id, &prod, None).unwrap();
        assert_eq!(view.meta["name"], "Production");
        assert!(!view.unlocked);
        let secret = Uuid::new_v4().to_string();
        assert_eq!(
            member
                .seal_secret_value(&p.id, &secret, &prod.id, "x".into())
                .unwrap_err(),
            VaultError::VaultNotOpen
        );
    }

    #[test]
    fn new_environments_get_their_own_key() {
        let keyring = unlocked();
        let p = project(&keyring);
        let qa = keyring
            .seal_environment(
                &p.id,
                None,
                &json!({ "name": "QA", "slug": "qa", "kind": "custom", "position": 2 }),
            )
            .unwrap();
        assert!(qa.encrypted_key.is_some());
        let renamed = keyring
            .seal_environment(&p.id, Some(&qa.id), &json!({ "name": "QA sandbox", "slug": "qa-sandbox", "kind": "custom", "position": 2 }))
            .unwrap();
        assert!(renamed.encrypted_key.is_none());
        let secret = Uuid::new_v4().to_string();
        assert!(
            keyring
                .seal_secret_value(&p.id, &secret, &qa.id, "x".into())
                .is_ok()
        );
    }

    #[test]
    fn rejects_non_object_metadata_and_bad_ids() {
        let keyring = unlocked();
        let p = project(&keyring);
        assert_eq!(
            keyring
                .seal_entry(&p.id, EntryKind::Folder, None, &json!("billing"))
                .unwrap_err(),
            VaultError::InvalidRecord
        );
        assert_eq!(
            keyring
                .seal_entry(&p.id.to_uppercase(), EntryKind::Folder, None, &json!({}))
                .unwrap_err(),
            VaultError::InvalidRecord
        );
    }
}

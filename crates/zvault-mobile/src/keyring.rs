//! Keys for the unlocked account and the read side of vaults and projects.
//!
//! Mirrors what the Mac app's keyring opens (vaults, items, projects,
//! environments, folders, secrets and member wraps) on top of the same
//! `zvault-crypto` primitives and associated data, so a record sealed on the
//! Mac opens here and nowhere else.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
use zvault_crypto::vault::{open_padded, unwrap_key};
use zvault_crypto::{
    BoxedShare, SharingKeyPair, SymmetricKey, environment_key_wrap_aad, project,
    project_key_wrap_aad, unwrap_key_from_member, vault,
};

use crate::records::{
    ACCOUNT_KID, Blob, EnvironmentRecord, ItemRecord, MEMBER_KEY_WRAP_KID, MemberWrap,
    ProjectRecord, VaultRecord, decode_key,
};

/// Errors shown to the app. Coarse on purpose: they never say which check failed.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Zvault is locked")]
    Locked,
    #[error("this vault or project is not open")]
    NotOpen,
    #[error("this item could not be decrypted")]
    Decrypt,
    #[error("invalid record")]
    InvalidRecord,
}

type Result<T> = core::result::Result<T, Error>;

const ITEM_KIND_LOGIN: &str = "login";

/// The decrypted contents of a login item.
#[derive(Default, Clone, PartialEq, Eq, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct ItemFields {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub notes: String,
    /// A canonical `otpauth://totp/` URI, or empty.
    #[serde(default)]
    pub totp: String,
}

impl std::fmt::Debug for ItemFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ItemFields")
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct ItemPlaintext {
    v: u32,
    kind: String,
    #[serde(flatten)]
    fields: ItemFields,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct VaultMeta {
    name: String,
}

#[derive(Deserialize)]
struct ValuePlaintext {
    value: String,
}

impl Drop for ValuePlaintext {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// A folder or secret, whose metadata is sealed with the project key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Folder,
    Secret,
}

struct Account {
    email: String,
    /// The account keyset key: wraps vault and project keys, and derives the
    /// sharing key pair that member wraps are addressed to.
    keyset: SymmetricKey,
}

/// Everything unwrapped this session. Locking drops (and so wipes) it all.
#[derive(Default)]
pub struct Keyring {
    account: Option<Account>,
    vaults: HashMap<String, SymmetricKey>,
    projects: HashMap<String, SymmetricKey>,
    environments: HashMap<(String, String), SymmetricKey>,
}

impl Keyring {
    pub fn unlock(&mut self, email: String, keyset: SymmetricKey) {
        *self = Self {
            account: Some(Account { email, keyset }),
            ..Self::default()
        };
    }

    pub fn lock(&mut self) {
        *self = Self::default();
    }

    pub fn email(&self) -> Option<&str> {
        self.account.as_ref().map(|a| a.email.as_str())
    }

    /// The account's sharing key pair, the same one the Mac derives.
    pub fn sharing_key_pair(&self) -> Result<SharingKeyPair> {
        Ok(SharingKeyPair::derive_from_keyset(self.keyset()?))
    }

    fn keyset(&self) -> Result<&SymmetricKey> {
        self.account
            .as_ref()
            .map(|a| &a.keyset)
            .ok_or(Error::Locked)
    }

    /// Unwraps a vault key and returns the vault's id and name.
    pub fn open_vault(&mut self, record: &VaultRecord) -> Result<(String, String)> {
        let id = canonical_id(&record.id)?;
        let key = unwrap_key(
            self.keyset()?,
            &record.encrypted_key.sealed(ACCOUNT_KID)?,
            &vault::aad::vault_key(&id),
        )
        .map_err(|_| Error::Decrypt)?;
        let json = open_padded(
            &key,
            &record.encrypted_meta.sealed(&id)?,
            &vault::aad::vault_meta(&id),
        )
        .map_err(|_| Error::Decrypt)?;
        let meta: VaultMeta = serde_json::from_slice(&json).map_err(|_| Error::Decrypt)?;
        self.vaults.insert(id.clone(), key);
        Ok((id, meta.name.clone()))
    }

    pub fn open_item(&self, vault_id: &str, record: &ItemRecord) -> Result<ItemFields> {
        let vault_id = canonical_id(vault_id)?;
        let item_id = canonical_id(&record.id)?;
        self.keyset()?;
        let vault_key = self.vaults.get(&vault_id).ok_or(Error::NotOpen)?;
        let item_key = unwrap_key(
            vault_key,
            &record.encrypted_key.sealed(&vault_id)?,
            &vault::aad::item_key(&vault_id, &item_id),
        )
        .map_err(|_| Error::Decrypt)?;
        let json = open_padded(
            &item_key,
            &record.encrypted_data.sealed(&item_id)?,
            &vault::aad::item_data(&vault_id, &item_id),
        )
        .map_err(|_| Error::Decrypt)?;
        let plaintext: ItemPlaintext = serde_json::from_slice(&json).map_err(|_| Error::Decrypt)?;
        if plaintext.v != 1 || plaintext.kind != ITEM_KIND_LOGIN {
            return Err(Error::Decrypt);
        }
        Ok(plaintext.fields)
    }

    /// Unwraps a project key and returns its metadata. `wrap` is this
    /// account's member wrap, for a project someone else shared.
    pub fn open_project(
        &mut self,
        record: &ProjectRecord,
        wrap: Option<&MemberWrap>,
    ) -> Result<Value> {
        let id = canonical_id(&record.id)?;
        let keyset = self.keyset()?;
        let key = match wrap {
            Some(wrap) => unwrap_member(keyset, wrap, &project_key_wrap_aad(&id))?,
            None => unwrap_key(
                keyset,
                &record.encrypted_key.sealed(ACCOUNT_KID)?,
                &project::aad::project_key(&id),
            )
            .map_err(|_| Error::Decrypt)?,
        };
        let meta = open_json(
            &key,
            &record.encrypted_meta,
            &project::aad::project_meta(&id),
            &id,
        )?;
        self.projects.insert(id, key);
        Ok(meta)
    }

    /// Returns an environment's metadata and whether this account can read
    /// its values, keeping the key when it can.
    pub fn open_environment(
        &mut self,
        project_id: &str,
        record: &EnvironmentRecord,
        wrap: Option<&MemberWrap>,
    ) -> Result<(Value, bool)> {
        let project_id = canonical_id(project_id)?;
        let env_id = canonical_id(&record.id)?;
        let keyset = self.keyset()?;
        let project_key = self.projects.get(&project_id).ok_or(Error::NotOpen)?;
        let meta = open_json(
            project_key,
            &record.encrypted_meta,
            &project::aad::environment_meta(&project_id, &env_id),
            &env_id,
        )?;
        let key = match (wrap, &record.encrypted_key) {
            (Some(wrap), _) => {
                let version = wrap.key_version.ok_or(Error::InvalidRecord)?;
                Some(unwrap_member(
                    keyset,
                    wrap,
                    &environment_key_wrap_aad(&project_id, &env_id, version),
                )?)
            }
            // A member wrap served without its public halves can't be opened.
            (None, Some(blob)) if blob.kid == MEMBER_KEY_WRAP_KID => None,
            (None, Some(blob)) => Some(
                unwrap_key(
                    keyset,
                    &blob.sealed(ACCOUNT_KID)?,
                    &project::aad::environment_key(&project_id, &env_id),
                )
                .map_err(|_| Error::Decrypt)?,
            ),
            (None, None) => None,
        };
        let unlocked = key.is_some();
        if let Some(key) = key {
            self.environments.insert((project_id, env_id), key);
        }
        Ok((meta, unlocked))
    }

    pub fn open_entry(
        &self,
        project_id: &str,
        kind: EntryKind,
        id: &str,
        blob: &Blob,
    ) -> Result<Value> {
        let project_id = canonical_id(project_id)?;
        let id = canonical_id(id)?;
        self.keyset()?;
        let key = self.projects.get(&project_id).ok_or(Error::NotOpen)?;
        let aad = match kind {
            EntryKind::Folder => project::aad::folder_meta(&project_id, &id),
            EntryKind::Secret => project::aad::secret_meta(&project_id, &id),
        };
        open_json(key, blob, &aad, &id)
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
        self.keyset()?;
        let key = self
            .environments
            .get(&(project_id.clone(), environment_id.clone()))
            .ok_or(Error::NotOpen)?;
        let json = open_padded(
            key,
            &blob.sealed(&environment_id)?,
            &project::aad::secret_value(&project_id, &secret_id, &environment_id),
        )
        .map_err(|_| Error::Decrypt)?;
        let mut plaintext: ValuePlaintext =
            serde_json::from_slice(&json).map_err(|_| Error::Decrypt)?;
        Ok(Zeroizing::new(std::mem::take(&mut plaintext.value)))
    }
}

fn unwrap_member(keyset: &SymmetricKey, wrap: &MemberWrap, aad: &[u8]) -> Result<SymmetricKey> {
    let me = SharingKeyPair::derive_from_keyset(keyset);
    if decode_key(&wrap.recipient_public_key)? != me.public_key() {
        // Wrapped to a key this account no longer has.
        return Err(Error::Decrypt);
    }
    let boxed = BoxedShare {
        ephemeral_public: decode_key(&wrap.ephemeral_public_key)?,
        sealed: wrap.blob.sealed(MEMBER_KEY_WRAP_KID)?,
    };
    unwrap_key_from_member(&me, &decode_key(&wrap.wrapper_public_key)?, aad, &boxed)
        .map_err(|_| Error::Decrypt)
}

fn open_json(key: &SymmetricKey, blob: &Blob, aad: &[u8], kid: &str) -> Result<Value> {
    let json = open_padded(key, &blob.sealed(kid)?, aad).map_err(|_| Error::Decrypt)?;
    let value: Value = serde_json::from_slice(&json).map_err(|_| Error::Decrypt)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(Error::Decrypt)
    }
}

/// Ids are bound into every ciphertext, so they must be one canonical string.
fn canonical_id(id: &str) -> Result<String> {
    let parsed = uuid::Uuid::try_parse(id).map_err(|_| Error::InvalidRecord)?;
    let canonical = parsed.hyphenated().to_string();
    if canonical != id {
        return Err(Error::InvalidRecord);
    }
    Ok(canonical)
}

#[cfg(test)]
pub(crate) mod tests {
    //! Records here are sealed exactly as the Mac app seals them (same
    //! primitives, associated data and `kid`s), then opened by the phone.

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use serde_json::json;
    use zvault_crypto::Sealed;
    use zvault_crypto::vault::{seal_padded, wrap_key};
    use zvault_crypto::wrap_key_to_member;

    use super::*;

    const VAULT: &str = "0b6f4f0e-2c1d-4c47-9a57-5d8a1e7f3c20";
    const ITEM: &str = "7d1c9a3b-6e2f-4a8b-9c0d-1e2f3a4b5c6d";
    const PROJECT: &str = "3f2a91c0-4b5d-4e6f-8a7b-9c0d1e2f3a4b";
    const ENV: &str = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    const SECRET: &str = "9c8b7a6d-5e4f-4d3c-8b2a-1f0e9d8c7b6a";

    pub fn blob(kid: &str, sealed: &Sealed) -> Value {
        json!({
            "v": 1,
            "alg": "xchacha20poly1305",
            "kid": kid,
            "nonce": B64.encode(sealed.nonce),
            "ct": B64.encode(&sealed.ciphertext),
        })
    }

    fn seal_json(key: &SymmetricKey, value: &Value, aad: &[u8], kid: &str) -> Value {
        let bytes = serde_json::to_vec(value).unwrap();
        blob(kid, &seal_padded(key, &bytes, aad).unwrap())
    }

    fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    fn unlocked() -> (Keyring, SymmetricKey) {
        let keyset = SymmetricKey::generate().unwrap();
        let mut k = Keyring::default();
        k.unlock(
            "me@example.com".into(),
            SymmetricKey::from_bytes(*keyset.as_bytes()),
        );
        (k, keyset)
    }

    #[test]
    fn opens_a_vault_and_its_login_item() {
        let (mut k, keyset) = unlocked();
        let vault_key = SymmetricKey::generate().unwrap();
        let item_key = SymmetricKey::generate().unwrap();
        let vault: VaultRecord = parse(json!({
            "id": VAULT,
            "encryptedKey": blob(ACCOUNT_KID, &wrap_key(&keyset, &vault_key, &vault::aad::vault_key(VAULT)).unwrap()),
            "encryptedMeta": seal_json(&vault_key, &json!({"v": 1, "name": "Personal"}), &vault::aad::vault_meta(VAULT), VAULT),
        }));
        let item: ItemRecord = parse(json!({
            "id": ITEM,
            "encryptedKey": blob(VAULT, &wrap_key(&vault_key, &item_key, &vault::aad::item_key(VAULT, ITEM)).unwrap()),
            "encryptedData": seal_json(&item_key, &json!({
                "v": 1, "kind": "login", "title": "GitHub", "username": "octo",
                "password": "hunter2", "urls": ["https://github.com"], "notes": "", "totp": ""
            }), &vault::aad::item_data(VAULT, ITEM), ITEM),
        }));

        assert_eq!(k.open_item(VAULT, &item), Err(Error::NotOpen));
        assert_eq!(
            k.open_vault(&vault).unwrap(),
            (VAULT.into(), "Personal".into())
        );
        let fields = k.open_item(VAULT, &item).unwrap();
        assert_eq!(fields.title, "GitHub");
        assert_eq!(fields.password, "hunter2");

        k.lock();
        assert_eq!(k.open_item(VAULT, &item), Err(Error::Locked));
    }

    #[test]
    fn another_account_cannot_open_the_vault() {
        let (mut k, _) = unlocked();
        let other = SymmetricKey::generate().unwrap();
        let vault_key = SymmetricKey::generate().unwrap();
        let vault: VaultRecord = parse(json!({
            "id": VAULT,
            "encryptedKey": blob(ACCOUNT_KID, &wrap_key(&other, &vault_key, &vault::aad::vault_key(VAULT)).unwrap()),
            "encryptedMeta": seal_json(&vault_key, &json!({"v": 1, "name": "x"}), &vault::aad::vault_meta(VAULT), VAULT),
        }));
        assert_eq!(k.open_vault(&vault), Err(Error::Decrypt));
    }

    fn own_project(keyset: &SymmetricKey, project_key: &SymmetricKey) -> ProjectRecord {
        parse(json!({
            "id": PROJECT,
            "encryptedKey": blob(ACCOUNT_KID, &wrap_key(keyset, project_key, &project::aad::project_key(PROJECT)).unwrap()),
            "encryptedMeta": seal_json(project_key, &json!({"name": "Payments", "slug": "payments"}), &project::aad::project_meta(PROJECT), PROJECT),
        }))
    }

    #[test]
    fn opens_an_own_project_down_to_a_secret_value() {
        let (mut k, keyset) = unlocked();
        let project_key = SymmetricKey::generate().unwrap();
        let env_key = SymmetricKey::generate().unwrap();

        let meta = k
            .open_project(&own_project(&keyset, &project_key), None)
            .unwrap();
        assert_eq!(meta["name"], "Payments");

        let env: EnvironmentRecord = parse(json!({
            "id": ENV,
            "encryptedMeta": seal_json(&project_key, &json!({"name": "Production", "slug": "production", "kind": "production", "position": 0}), &project::aad::environment_meta(PROJECT, ENV), ENV),
            "encryptedKey": blob(ACCOUNT_KID, &wrap_key(&keyset, &env_key, &project::aad::environment_key(PROJECT, ENV)).unwrap()),
        }));
        let (env_meta, unlocked) = k.open_environment(PROJECT, &env, None).unwrap();
        assert_eq!(env_meta["slug"], "production");
        assert!(unlocked);

        let secret_meta: Blob = parse(seal_json(
            &project_key,
            &json!({"name": "Stripe key", "key": "STRIPE_KEY"}),
            &project::aad::secret_meta(PROJECT, SECRET),
            SECRET,
        ));
        let meta = k
            .open_entry(PROJECT, EntryKind::Secret, SECRET, &secret_meta)
            .unwrap();
        assert_eq!(meta["key"], "STRIPE_KEY");
        // The same blob is not a folder.
        assert!(
            k.open_entry(PROJECT, EntryKind::Folder, SECRET, &secret_meta)
                .is_err()
        );

        let value: Blob = parse(seal_json(
            &env_key,
            &json!({"value": "sk_live_123"}),
            &project::aad::secret_value(PROJECT, SECRET, ENV),
            ENV,
        ));
        assert_eq!(
            k.open_secret_value(PROJECT, SECRET, ENV, &value)
                .unwrap()
                .as_str(),
            "sk_live_123"
        );
    }

    #[test]
    fn environment_without_a_grant_is_listed_but_locked() {
        let (mut k, keyset) = unlocked();
        let project_key = SymmetricKey::generate().unwrap();
        k.open_project(&own_project(&keyset, &project_key), None)
            .unwrap();
        let env: EnvironmentRecord = parse(json!({
            "id": ENV,
            "encryptedMeta": seal_json(&project_key, &json!({"name": "Staging", "slug": "staging", "kind": "staging", "position": 1}), &project::aad::environment_meta(PROJECT, ENV), ENV),
            "encryptedKey": null,
        }));
        let (_, unlocked) = k.open_environment(PROJECT, &env, None).unwrap();
        assert!(!unlocked);
    }

    #[test]
    fn opens_a_project_shared_by_another_member() {
        let (mut k, keyset) = unlocked();
        let me = SharingKeyPair::derive_from_keyset(&keyset);
        let owner = SharingKeyPair::generate().unwrap();
        let project_key = SymmetricKey::generate().unwrap();
        let env_key = SymmetricKey::generate().unwrap();
        let wrap = |aad: &[u8], key: &SymmetricKey, version: Option<u32>| -> MemberWrap {
            let boxed = wrap_key_to_member(&owner, &me.public_key(), aad, key).unwrap();
            parse(json!({
                "recipientId": "a",
                "recipientPublicKey": B64.encode(me.public_key()),
                "wrapperPublicKey": B64.encode(owner.public_key()),
                "ephemeralPublicKey": B64.encode(boxed.ephemeral_public),
                "blob": blob(MEMBER_KEY_WRAP_KID, &boxed.sealed),
                "keyVersion": version,
            }))
        };
        let project: ProjectRecord = parse(json!({
            "id": PROJECT,
            "encryptedKey": {"v": 1, "alg": "xchacha20poly1305", "kid": MEMBER_KEY_WRAP_KID, "nonce": B64.encode([0u8; 24]), "ct": "AA"},
            "encryptedMeta": seal_json(&project_key, &json!({"name": "Shared", "slug": "shared"}), &project::aad::project_meta(PROJECT), PROJECT),
        }));
        let project_wrap = wrap(&project_key_wrap_aad(PROJECT), &project_key, None);
        assert_eq!(
            k.open_project(&project, Some(&project_wrap)).unwrap()["name"],
            "Shared"
        );

        let env: EnvironmentRecord = parse(json!({
            "id": ENV,
            "encryptedMeta": seal_json(&project_key, &json!({"name": "Dev", "slug": "dev", "kind": "development", "position": 0}), &project::aad::environment_meta(PROJECT, ENV), ENV),
            "encryptedKey": {"v": 1, "alg": "xchacha20poly1305", "kid": MEMBER_KEY_WRAP_KID, "nonce": B64.encode([0u8; 24]), "ct": "AA"},
        }));
        // Without the wrap it is shown as locked.
        assert!(!k.open_environment(PROJECT, &env, None).unwrap().1);
        let env_wrap = wrap(
            &environment_key_wrap_aad(PROJECT, ENV, 3),
            &env_key,
            Some(3),
        );
        assert!(
            k.open_environment(PROJECT, &env, Some(&env_wrap))
                .unwrap()
                .1
        );
    }

    #[test]
    fn ids_must_be_canonical() {
        assert!(canonical_id(VAULT).is_ok());
        assert_eq!(
            canonical_id(&VAULT.to_uppercase()),
            Err(Error::InvalidRecord)
        );
    }
}

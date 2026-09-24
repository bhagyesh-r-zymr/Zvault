//! Vault and item commands. Keys stay in [`Keyring`] on the Rust side; the UI
//! sends and receives only ciphertext records (to relay to the API) and the
//! decrypted fields of the item it is showing.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
use zvault_crypto::vault::{aad, open_padded, seal_padded, unwrap_key, wrap_key};
use zvault_crypto::{NONCE_LEN, Sealed, SymmetricKey};

use crate::CRYPTO_VERSION;

const ALG: &str = "xchacha20poly1305";
/// `kid` of a vault key wrapped by the account key. Matches the API.
const ACCOUNT_KID: &str = "account";
const ITEM_KIND_LOGIN: &str = "login";

/// Errors shown to the UI. Coarse on purpose: they never say which check failed.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum VaultError {
    #[error("Zvault is locked")]
    Locked,
    #[error("this vault is not open")]
    VaultNotOpen,
    #[error("this item could not be decrypted")]
    Decrypt,
    #[error("this item could not be encrypted")]
    Encrypt,
    #[error("invalid record")]
    InvalidRecord,
}

impl Serialize for VaultError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> core::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type Result<T> = core::result::Result<T, VaultError>;

/// An AEAD ciphertext in the wire format of `EncryptedBlob` in `@zvault/shared`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Blob {
    pub v: u32,
    pub alg: String,
    pub kid: String,
    pub nonce: String,
    pub ct: String,
}

impl Blob {
    fn new(kid: &str, sealed: &Sealed) -> Self {
        Self {
            v: CRYPTO_VERSION,
            alg: ALG.into(),
            kid: kid.into(),
            nonce: B64.encode(sealed.nonce),
            ct: B64.encode(&sealed.ciphertext),
        }
    }

    /// Decodes the blob, checking it was sealed by the key the caller expects.
    fn sealed(&self, expected_kid: &str) -> Result<Sealed> {
        if self.v != CRYPTO_VERSION || self.alg != ALG || self.kid != expected_kid {
            return Err(VaultError::InvalidRecord);
        }
        let nonce: [u8; NONCE_LEN] = B64
            .decode(&self.nonce)
            .ok()
            .and_then(|n| n.try_into().ok())
            .ok_or(VaultError::InvalidRecord)?;
        let ciphertext = B64
            .decode(&self.ct)
            .map_err(|_| VaultError::InvalidRecord)?;
        Ok(Sealed { nonce, ciphertext })
    }
}

/// A vault record as uploaded to and returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCipher {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_meta: Blob,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultSummary {
    pub id: String,
    pub name: String,
}

/// An item's ciphertext as uploaded to and returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCipher {
    pub id: String,
    pub encrypted_key: Blob,
    pub encrypted_data: Blob,
}

/// The decrypted contents of a login item.
#[derive(Default, Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
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
}

impl std::fmt::Debug for ItemFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ItemFields")
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

/// What the item list shows. Leaves the password and notes in Rust.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ItemSummary {
    pub title: String,
    pub username: String,
    pub url: Option<String>,
}

impl From<&ItemFields> for ItemSummary {
    fn from(f: &ItemFields) -> Self {
        Self {
            title: f.title.clone(),
            username: f.username.clone(),
            url: f.urls.first().cloned(),
        }
    }
}

/// Plaintext layout inside `encryptedData`, versioned for later item kinds.
#[derive(Serialize, Deserialize)]
struct ItemPlaintext {
    v: u32,
    kind: String,
    #[serde(flatten)]
    fields: ItemFields,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct VaultMeta {
    v: u32,
    name: String,
}

/// Keys for the unlocked account. Dropping or locking wipes them.
#[derive(Default)]
pub struct Keyring(Mutex<Keys>);

#[derive(Default)]
struct Keys {
    account: Option<SymmetricKey>,
    vaults: HashMap<String, SymmetricKey>,
}

impl Keyring {
    /// Called by the unlock flow once the account key has been derived.
    pub fn unlock(&self, account_key: SymmetricKey) {
        let mut keys = self.keys();
        keys.vaults.clear();
        keys.account = Some(account_key);
    }

    pub fn lock(&self) {
        let mut keys = self.keys();
        keys.vaults.clear();
        keys.account = None;
    }

    fn keys(&self) -> std::sync::MutexGuard<'_, Keys> {
        // A panic while holding the lock can't leave keys half-written, so
        // recovering the guard is safe.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn create_vault(&self, name: &str) -> Result<(VaultCipher, VaultSummary)> {
        let mut keys = self.keys();
        let account = keys.account.as_ref().ok_or(VaultError::Locked)?;
        let id = Uuid::new_v4().to_string();
        let vault_key = SymmetricKey::generate().map_err(|_| VaultError::Encrypt)?;
        let wrapped =
            wrap_key(account, &vault_key, &aad::vault_key(&id)).map_err(|_| VaultError::Encrypt)?;
        let meta = VaultMeta {
            v: 1,
            name: name.trim().into(),
        };
        let meta_json = Zeroizing::new(serde_json::to_vec(&meta).map_err(|_| VaultError::Encrypt)?);
        let sealed_meta = seal_padded(&vault_key, &meta_json, &aad::vault_meta(&id))
            .map_err(|_| VaultError::Encrypt)?;
        keys.vaults.insert(id.clone(), vault_key);
        Ok((
            VaultCipher {
                encrypted_key: Blob::new(ACCOUNT_KID, &wrapped),
                encrypted_meta: Blob::new(&id, &sealed_meta),
                id: id.clone(),
            },
            VaultSummary {
                id,
                name: meta.name.clone(),
            },
        ))
    }

    /// Unwraps a vault key from its record and keeps it for item operations.
    pub fn open_vault(&self, vault: &VaultCipher) -> Result<VaultSummary> {
        let id = canonical_id(&vault.id)?;
        let mut keys = self.keys();
        let account = keys.account.as_ref().ok_or(VaultError::Locked)?;
        let vault_key = unwrap_key(
            account,
            &vault.encrypted_key.sealed(ACCOUNT_KID)?,
            &aad::vault_key(&id),
        )
        .map_err(|_| VaultError::Decrypt)?;
        let meta = open_padded(
            &vault_key,
            &vault.encrypted_meta.sealed(&id)?,
            &aad::vault_meta(&id),
        )
        .map_err(|_| VaultError::Decrypt)?;
        let meta: VaultMeta = serde_json::from_slice(&meta).map_err(|_| VaultError::Decrypt)?;
        keys.vaults.insert(id.clone(), vault_key);
        Ok(VaultSummary {
            id,
            name: meta.name.clone(),
        })
    }

    /// Encrypts an item. Pass the existing record when editing so the item
    /// keeps its key; a new item gets a fresh id and key.
    pub fn seal_item(
        &self,
        vault_id: &str,
        existing: Option<&ItemCipher>,
        fields: ItemFields,
    ) -> Result<ItemCipher> {
        let vault_id = canonical_id(vault_id)?;
        let keys = self.keys();
        let vault_key = vault_key(&keys, &vault_id)?;
        let (item_id, item_key) = match existing {
            Some(item) => {
                let id = canonical_id(&item.id)?;
                let key = unwrap_item_key(vault_key, &vault_id, &id, item)?;
                (id, key)
            }
            None => (
                Uuid::new_v4().to_string(),
                SymmetricKey::generate().map_err(|_| VaultError::Encrypt)?,
            ),
        };
        let wrapped = wrap_key(vault_key, &item_key, &aad::item_key(&vault_id, &item_id))
            .map_err(|_| VaultError::Encrypt)?;
        let plaintext = ItemPlaintext {
            v: 1,
            kind: ITEM_KIND_LOGIN.into(),
            fields: normalize(fields),
        };
        let json = Zeroizing::new(serde_json::to_vec(&plaintext).map_err(|_| VaultError::Encrypt)?);
        let sealed = seal_padded(&item_key, &json, &aad::item_data(&vault_id, &item_id))
            .map_err(|_| VaultError::Encrypt)?;
        Ok(ItemCipher {
            encrypted_key: Blob::new(&vault_id, &wrapped),
            encrypted_data: Blob::new(&item_id, &sealed),
            id: item_id,
        })
    }

    pub fn open_item(&self, vault_id: &str, item: &ItemCipher) -> Result<ItemFields> {
        let vault_id = canonical_id(vault_id)?;
        let item_id = canonical_id(&item.id)?;
        let keys = self.keys();
        let item_key = unwrap_item_key(vault_key(&keys, &vault_id)?, &vault_id, &item_id, item)?;
        let json = open_padded(
            &item_key,
            &item.encrypted_data.sealed(&item_id)?,
            &aad::item_data(&vault_id, &item_id),
        )
        .map_err(|_| VaultError::Decrypt)?;
        let plaintext: ItemPlaintext =
            serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)?;
        if plaintext.v != 1 || plaintext.kind != ITEM_KIND_LOGIN {
            return Err(VaultError::Decrypt);
        }
        Ok(plaintext.fields)
    }
}

fn vault_key<'a>(keys: &'a Keys, vault_id: &str) -> Result<&'a SymmetricKey> {
    if keys.account.is_none() {
        return Err(VaultError::Locked);
    }
    keys.vaults.get(vault_id).ok_or(VaultError::VaultNotOpen)
}

fn unwrap_item_key(
    vault_key: &SymmetricKey,
    vault_id: &str,
    item_id: &str,
    item: &ItemCipher,
) -> Result<SymmetricKey> {
    unwrap_key(
        vault_key,
        &item.encrypted_key.sealed(vault_id)?,
        &aad::item_key(vault_id, item_id),
    )
    .map_err(|_| VaultError::Decrypt)
}

/// Ids are bound into every ciphertext, so they must be one canonical string.
fn canonical_id(id: &str) -> Result<String> {
    let parsed = Uuid::try_parse(id).map_err(|_| VaultError::InvalidRecord)?;
    let canonical = parsed.hyphenated().to_string();
    if canonical != id {
        return Err(VaultError::InvalidRecord);
    }
    Ok(canonical)
}

fn normalize(mut fields: ItemFields) -> ItemFields {
    fields.title = fields.title.trim().into();
    fields.username = fields.username.trim().into();
    fields.urls.retain(|u| !u.trim().is_empty());
    for url in &mut fields.urls {
        *url = url.trim().into();
    }
    fields
}

#[tauri::command]
pub fn vault_create(keyring: tauri::State<'_, Keyring>, name: String) -> Result<NewVault> {
    let (record, summary) = keyring.create_vault(&name)?;
    Ok(NewVault { record, summary })
}

#[derive(Serialize)]
pub struct NewVault {
    record: VaultCipher,
    summary: VaultSummary,
}

#[tauri::command]
pub fn vault_open(keyring: tauri::State<'_, Keyring>, vault: VaultCipher) -> Result<VaultSummary> {
    keyring.open_vault(&vault)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_seal(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    existing: Option<ItemCipher>,
    fields: ItemFields,
) -> Result<ItemCipher> {
    keyring.seal_item(&vault_id, existing.as_ref(), fields)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_open(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    item: ItemCipher,
) -> Result<ItemFields> {
    keyring.open_item(&vault_id, &item)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_summary(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    item: ItemCipher,
) -> Result<ItemSummary> {
    keyring
        .open_item(&vault_id, &item)
        .map(|f| ItemSummary::from(&f))
}

#[tauri::command]
pub fn vault_lock(keyring: tauri::State<'_, Keyring>) {
    keyring.lock();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unlocked() -> Keyring {
        let keyring = Keyring::default();
        keyring.unlock(SymmetricKey::generate().unwrap());
        keyring
    }

    fn login() -> ItemFields {
        ItemFields {
            title: "  Example ".into(),
            username: "alice@example.com".into(),
            password: "correct horse battery staple".into(),
            urls: vec!["https://example.com".into(), "  ".into()],
            notes: "recovery codes in the safe".into(),
        }
    }

    #[test]
    fn requires_an_unlocked_account() {
        let keyring = Keyring::default();
        assert_eq!(
            keyring.create_vault("Personal").err(),
            Some(VaultError::Locked)
        );
    }

    #[test]
    fn creates_and_reopens_a_vault() {
        let account = SymmetricKey::generate().unwrap();
        let bytes = *account.as_bytes();
        let keyring = Keyring::default();
        keyring.unlock(account);
        let (record, summary) = keyring.create_vault(" Personal ").unwrap();
        assert_eq!(summary.name, "Personal");
        assert_eq!(record.encrypted_key.kid, ACCOUNT_KID);

        // A fresh session (e.g. after relaunch) with the same account key.
        let other = Keyring::default();
        other.unlock(SymmetricKey::from_bytes(bytes));
        assert_eq!(other.open_vault(&record).unwrap(), summary);
    }

    #[test]
    fn seals_opens_and_edits_items() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let item = keyring.seal_item(&vault.id, None, login()).unwrap();
        assert_eq!(item.encrypted_key.kid, vault.id);
        assert_eq!(item.encrypted_data.kid, item.id);

        let opened = keyring.open_item(&vault.id, &item).unwrap();
        assert_eq!(opened.title, "Example");
        let summary = ItemSummary::from(&opened);
        assert_eq!(summary.url.as_deref(), Some("https://example.com"));
        assert_eq!(opened.urls, vec!["https://example.com".to_string()]);

        let mut edited = opened.clone();
        edited.password = "new password".into();
        let v2 = keyring.seal_item(&vault.id, Some(&item), edited).unwrap();
        assert_eq!(v2.id, item.id);
        assert_ne!(v2.encrypted_data, item.encrypted_data);
        assert_eq!(
            keyring.open_item(&vault.id, &v2).unwrap().password,
            "new password"
        );
    }

    #[test]
    fn ciphertext_hides_the_plaintext() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let item = keyring.seal_item(&vault.id, None, login()).unwrap();
        let wire = serde_json::to_string(&item).unwrap();
        assert!(!wire.contains("alice"));
        assert!(!wire.contains("horse"));
    }

    #[test]
    fn rejects_items_moved_between_records() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let a = keyring.seal_item(&vault.id, None, login()).unwrap();
        let b = keyring
            .seal_item(&vault.id, None, ItemFields::default())
            .unwrap();

        // The server swaps a's data into b's record.
        let swapped = ItemCipher {
            encrypted_data: Blob {
                kid: b.id.clone(),
                ..a.encrypted_data.clone()
            },
            ..b.clone()
        };
        assert_eq!(
            keyring.open_item(&vault.id, &swapped),
            Err(VaultError::Decrypt)
        );

        // Or relabels a whole item into another vault.
        let (other, _) = keyring.create_vault("Work").unwrap();
        assert!(keyring.open_item(&other.id, &a).is_err());
    }

    #[test]
    fn locking_forgets_keys() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let item = keyring.seal_item(&vault.id, None, login()).unwrap();
        keyring.lock();
        assert_eq!(keyring.open_item(&vault.id, &item), Err(VaultError::Locked));
    }

    #[test]
    fn rejects_non_canonical_ids() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let upper = vault.id.to_uppercase();
        assert_eq!(
            keyring.seal_item(&upper, None, login()).err(),
            Some(VaultError::InvalidRecord)
        );
    }
}

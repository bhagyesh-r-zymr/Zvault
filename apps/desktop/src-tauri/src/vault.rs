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
use crate::projects::ProjectKeys;

const ALG: &str = "xchacha20poly1305";
/// `kid` of a vault key wrapped by the account key. Matches the API.
pub(crate) const ACCOUNT_KID: &str = "account";
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
    #[error("{0}")]
    OneTimePassword(#[from] zvault_otp::OtpError),
    #[error("{0}")]
    Passkey(#[from] zvault_passkeys::PasskeyError),
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
    pub(crate) fn new(kid: &str, sealed: &Sealed) -> Self {
        Self {
            v: CRYPTO_VERSION,
            alg: ALG.into(),
            kid: kid.into(),
            nonce: B64.encode(sealed.nonce),
            ct: B64.encode(&sealed.ciphertext),
        }
    }

    /// Decodes the blob, checking it was sealed by the key the caller expects.
    pub(crate) fn sealed(&self, expected_kid: &str) -> Result<Sealed> {
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
    /// One-time password setup, as a canonical `otpauth://totp/` URI, or
    /// empty. Like the password, it never leaves the encrypted item.
    #[serde(default)]
    pub totp: String,
    /// The item's passkey, without its private key, which stays in Rust.
    /// Taken out before sealing: the stored passkey lives in
    /// [`ItemPlaintext::passkey`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passkey: Option<PasskeyFields>,
}

/// A passkey as the UI sees and edits it.
///
/// To create one, send only `rpId` and `userName`; to import one, also send
/// `credentialId`, `privateKey` and optionally `userHandle`. An existing
/// passkey is kept when its `credentialId` comes back unchanged; only its
/// user name can be edited. The private key is accepted but never returned.
#[derive(Default, Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyFields {
    #[serde(default)]
    pub rp_id: String,
    #[serde(default)]
    pub user_name: String,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub credential_id: String,
    /// Base64url SubjectPublicKeyInfo. Output only.
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    #[zeroize(skip)]
    pub created_at: i64,
    /// Import only. Never serialized.
    #[serde(default, skip_serializing)]
    pub private_key: String,
}

impl TryFrom<&zvault_passkeys::Passkey> for PasskeyFields {
    type Error = VaultError;

    fn try_from(p: &zvault_passkeys::Passkey) -> Result<Self> {
        Ok(Self {
            rp_id: p.rp_id.clone(),
            user_name: p.user_name.clone(),
            user_handle: p.user_handle.clone(),
            credential_id: p.credential_id.clone(),
            public_key: p.public_key()?,
            created_at: p.created_at,
            private_key: String::new(),
        })
    }
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
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub title: String,
    pub username: String,
    pub url: Option<String>,
    /// Whether the item holds a one-time password.
    pub has_totp: bool,
    /// Whether the item holds a passkey.
    pub has_passkey: bool,
}

impl From<&ItemFields> for ItemSummary {
    fn from(f: &ItemFields) -> Self {
        Self {
            title: f.title.clone(),
            username: f.username.clone(),
            url: f.urls.first().cloned(),
            has_totp: !f.totp.is_empty(),
            has_passkey: f.passkey.is_some(),
        }
    }
}

/// Plaintext layout inside `encryptedData`, versioned for later item kinds.
///
/// A passkey is a field of a login item, as in 1Password, so apps that
/// predate passkeys still open these items.
#[derive(Serialize, Deserialize)]
struct ItemPlaintext {
    v: u32,
    kind: String,
    #[serde(flatten)]
    fields: ItemFields,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passkey: Option<zvault_passkeys::Passkey>,
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
    projects: ProjectKeys,
}

impl Keyring {
    /// Called by the unlock flow once the account key has been derived.
    pub fn unlock(&self, account_key: SymmetricKey) {
        let mut keys = self.keys();
        keys.vaults.clear();
        keys.projects = ProjectKeys::default();
        keys.account = Some(account_key);
    }

    pub fn lock(&self) {
        let mut keys = self.keys();
        keys.vaults.clear();
        keys.projects = ProjectKeys::default();
        keys.account = None;
    }

    /// Runs `f` with the account key and the unlocked project keys.
    pub(crate) fn with_project_keys<R>(
        &self,
        f: impl FnOnce(&SymmetricKey, &mut ProjectKeys) -> Result<R>,
    ) -> Result<R> {
        let mut keys = self.keys();
        let Keys {
            account, projects, ..
        } = &mut *keys;
        f(account.as_ref().ok_or(VaultError::Locked)?, projects)
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
        let (item_id, item_key, stored_passkey) = match existing {
            Some(item) => {
                let id = canonical_id(&item.id)?;
                let key = unwrap_item_key(vault_key, &vault_id, &id, item)?;
                let old = open_plaintext(&key, &vault_id, &id, item)?;
                (id, key, old.passkey.clone())
            }
            None => (
                Uuid::new_v4().to_string(),
                SymmetricKey::generate().map_err(|_| VaultError::Encrypt)?,
                None,
            ),
        };
        let wrapped = wrap_key(vault_key, &item_key, &aad::item_key(&vault_id, &item_id))
            .map_err(|_| VaultError::Encrypt)?;
        let mut fields = normalize(fields)?;
        let passkey = resolve_passkey(fields.passkey.take(), stored_passkey)?;
        let plaintext = ItemPlaintext {
            v: 1,
            kind: ITEM_KIND_LOGIN.into(),
            fields,
            passkey,
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
        let (mut fields, passkey) = self.open_item_with_passkey(vault_id, item)?;
        fields.passkey = passkey.as_ref().map(PasskeyFields::try_from).transpose()?;
        Ok(fields)
    }

    /// Opens an item along with its stored passkey, private key included.
    /// For Rust-side use only (signing, sharing); never return it to the UI.
    pub(crate) fn open_item_with_passkey(
        &self,
        vault_id: &str,
        item: &ItemCipher,
    ) -> Result<(ItemFields, Option<zvault_passkeys::Passkey>)> {
        let vault_id = canonical_id(vault_id)?;
        let item_id = canonical_id(&item.id)?;
        let keys = self.keys();
        let item_key = unwrap_item_key(vault_key(&keys, &vault_id)?, &vault_id, &item_id, item)?;
        let mut plaintext = open_plaintext(&item_key, &vault_id, &item_id, item)?;
        let passkey = plaintext.passkey.take();
        let mut fields = std::mem::take(&mut plaintext.fields);
        fields.passkey = None;
        Ok((fields, passkey))
    }
}

fn open_plaintext(
    item_key: &SymmetricKey,
    vault_id: &str,
    item_id: &str,
    item: &ItemCipher,
) -> Result<ItemPlaintext> {
    let json = open_padded(
        item_key,
        &item.encrypted_data.sealed(item_id)?,
        &aad::item_data(vault_id, item_id),
    )
    .map_err(|_| VaultError::Decrypt)?;
    let plaintext: ItemPlaintext =
        serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)?;
    if plaintext.v != 1 || plaintext.kind != ITEM_KIND_LOGIN {
        return Err(VaultError::Decrypt);
    }
    if let Some(passkey) = &plaintext.passkey {
        passkey.validate().map_err(|_| VaultError::Decrypt)?;
    }
    Ok(plaintext)
}

/// Works out the passkey to store from what the UI sent and what the item
/// already holds. See [`PasskeyFields`].
fn resolve_passkey(
    incoming: Option<PasskeyFields>,
    stored: Option<zvault_passkeys::Passkey>,
) -> Result<Option<zvault_passkeys::Passkey>> {
    let Some(p) = incoming else {
        return Ok(None);
    };
    let now = unix_now();
    if p.private_key.trim().is_empty() {
        if let Some(mut stored) = stored.filter(|s| s.credential_id == p.credential_id) {
            stored.rename_user(&p.user_name)?;
            return Ok(Some(stored));
        }
        if p.credential_id.trim().is_empty() {
            return Ok(Some(zvault_passkeys::Passkey::generate(
                &p.rp_id,
                &p.user_name,
                now,
            )?));
        }
        return Err(zvault_passkeys::PasskeyError::InvalidPrivateKey.into());
    }
    Ok(Some(zvault_passkeys::Passkey::import(
        &p.rp_id,
        &p.user_name,
        &p.credential_id,
        &p.user_handle,
        &p.private_key,
        now,
    )?))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
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
pub(crate) fn canonical_id(id: &str) -> Result<String> {
    let parsed = Uuid::try_parse(id).map_err(|_| VaultError::InvalidRecord)?;
    let canonical = parsed.hyphenated().to_string();
    if canonical != id {
        return Err(VaultError::InvalidRecord);
    }
    Ok(canonical)
}

fn normalize(mut fields: ItemFields) -> Result<ItemFields> {
    fields.title = fields.title.trim().into();
    fields.username = fields.username.trim().into();
    fields.urls.retain(|u| !u.trim().is_empty());
    for url in &mut fields.urls {
        *url = url.trim().into();
    }
    // Store one canonical form, and refuse a key that can't produce codes.
    if !fields.totp.trim().is_empty() {
        let uri = zvault_otp::Totp::parse(&fields.totp)?.to_uri();
        fields.totp.zeroize();
        fields.totp.push_str(&uri);
    } else {
        fields.totp.clear();
    }
    Ok(fields)
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

/// The item's current one-time password, or None when it has none. Computed
/// here so the setup key stays in Rust while the code is on screen.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_totp_code(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    item: ItemCipher,
) -> Result<Option<crate::otp::OtpCode>> {
    let fields = keyring.open_item(&vault_id, &item)?;
    if fields.totp.is_empty() {
        return Ok(None);
    }
    let totp = zvault_otp::Totp::parse(&fields.totp)?;
    Ok(Some(crate::otp::OtpCode::now(&totp)))
}

/// Signs a fresh WebAuthn challenge with the item's passkey and verifies it
/// with the public key, as the website would. The private key stays here.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_passkey_test(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    item: ItemCipher,
) -> Result<()> {
    let (_, passkey) = keyring.open_item_with_passkey(&vault_id, &item)?;
    passkey.ok_or(VaultError::InvalidRecord)?.self_test()?;
    Ok(())
}

/// `SharedItemPayload` in `@zvault/shared`. Empty fields are left out.
/// One-time password seeds are not shared.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePayload<'a> {
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
    passkey: Option<SharedPasskey>,
}

/// `SharedPasskey` in `@zvault/shared`: everything needed to use the passkey
/// elsewhere, private key included.
#[derive(Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedPasskey {
    rp_id: String,
    user_name: String,
    user_handle: String,
    credential_id: String,
    private_key: String,
}

impl SharedPasskey {
    pub(crate) fn of(p: &zvault_passkeys::Passkey) -> Result<Self> {
        Ok(Self {
            rp_id: p.rp_id.clone(),
            user_name: p.user_name.clone(),
            user_handle: p.user_handle.clone(),
            credential_id: p.credential_id.clone(),
            private_key: p.private_key_pem()?.to_string(),
        })
    }
}

/// The item as a `SharedItemPayload` JSON string, ready for
/// `share_link_create` or `share_seal_to`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn item_share_payload(
    keyring: tauri::State<'_, Keyring>,
    vault_id: String,
    item: ItemCipher,
) -> Result<String> {
    share_payload(&keyring, &vault_id, &item).map(|s| s.to_string())
}

fn share_payload(
    keyring: &Keyring,
    vault_id: &str,
    item: &ItemCipher,
) -> Result<Zeroizing<String>> {
    let (fields, passkey) = keyring.open_item_with_passkey(vault_id, item)?;
    let payload = SharePayload {
        v: 1,
        title: if fields.title.is_empty() {
            "Untitled"
        } else {
            &fields.title
        },
        username: &fields.username,
        password: &fields.password,
        url: fields.urls.first().map_or("", String::as_str),
        notes: &fields.notes,
        passkey: passkey.as_ref().map(SharedPasskey::of).transpose()?,
    };
    serde_json::to_string(&payload)
        .map(Zeroizing::new)
        .map_err(|_| VaultError::Encrypt)
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
            totp: String::new(),
            passkey: None,
        }
    }

    fn new_passkey(rp_id: &str) -> PasskeyFields {
        let mut p = PasskeyFields::default();
        p.rp_id = rp_id.into();
        p.user_name = "alice@example.com".into();
        p
    }

    #[test]
    fn creates_keeps_and_removes_a_passkey() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let mut fields = login();
        fields.passkey = Some(new_passkey("https://GitHub.com/login"));
        let item = keyring.seal_item(&vault.id, None, fields).unwrap();

        let opened = keyring.open_item(&vault.id, &item).unwrap();
        let pk = opened.passkey.clone().unwrap();
        assert_eq!(pk.rp_id, "github.com");
        assert!(!pk.public_key.is_empty());
        assert!(pk.private_key.is_empty());
        assert!(ItemSummary::from(&opened).has_passkey);
        // The UI never receives the private key.
        let to_ui = serde_json::to_string(&opened).unwrap();
        assert!(!to_ui.contains("privateKey"));
        // Nor can the server read any of it.
        let wire = serde_json::to_string(&item).unwrap();
        assert!(!wire.contains("github.com"));

        // Editing the item keeps the same key pair.
        let mut edited = opened.clone();
        edited.passkey.as_mut().unwrap().user_name = "alice2".into();
        edited.passkey.as_mut().unwrap().rp_id = "evil.com".into();
        let v2 = keyring.seal_item(&vault.id, Some(&item), edited).unwrap();
        let pk2 = keyring
            .open_item(&vault.id, &v2)
            .unwrap()
            .passkey
            .clone()
            .unwrap();
        assert_eq!(pk2.credential_id, pk.credential_id);
        assert_eq!(pk2.public_key, pk.public_key);
        assert_eq!(pk2.rp_id, "github.com");
        assert_eq!(pk2.user_name, "alice2");
        let (_, stored) = keyring.open_item_with_passkey(&vault.id, &v2).unwrap();
        stored.unwrap().self_test().unwrap();

        // Sending it back without the passkey removes it.
        let mut removed = keyring.open_item(&vault.id, &v2).unwrap();
        removed.passkey = None;
        let v3 = keyring.seal_item(&vault.id, Some(&v2), removed).unwrap();
        assert!(keyring.open_item(&vault.id, &v3).unwrap().passkey.is_none());
    }

    #[test]
    fn a_passkey_cannot_be_claimed_without_its_key() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let mut fields = login();
        let mut p = new_passkey("example.com");
        p.credential_id = "AAEC".into();
        fields.passkey = Some(p);
        assert!(matches!(
            keyring.seal_item(&vault.id, None, fields),
            Err(VaultError::Passkey(_))
        ));
    }

    #[test]
    fn imports_a_passkey_and_shares_it() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let source = zvault_passkeys::Passkey::generate("example.com", "bob", 0).unwrap();
        let mut fields = login();
        let mut p = PasskeyFields::default();
        p.rp_id = "example.com".into();
        p.user_name = "bob".into();
        p.credential_id = source.credential_id.clone();
        p.private_key = source.private_key_pem().unwrap().to_string();
        fields.passkey = Some(p);
        let item = keyring.seal_item(&vault.id, None, fields).unwrap();
        let opened = keyring.open_item(&vault.id, &item).unwrap();
        assert_eq!(
            opened.passkey.as_ref().unwrap().public_key,
            source.public_key().unwrap()
        );

        let payload = share_payload(&keyring, &vault.id, &item).unwrap();
        let json: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(json["passkey"]["rpId"], "example.com");
        assert!(
            json["passkey"]["privateKey"]
                .as_str()
                .unwrap()
                .starts_with("-----BEGIN PRIVATE KEY-----")
        );
        assert_eq!(json["username"], "alice@example.com");
    }

    #[test]
    fn stores_the_passkey_once_in_the_plaintext() {
        let plaintext = ItemPlaintext {
            v: 1,
            kind: ITEM_KIND_LOGIN.into(),
            fields: login(),
            passkey: Some(zvault_passkeys::Passkey::generate("example.com", "a", 0).unwrap()),
        };
        let json = serde_json::to_string(&plaintext).unwrap();
        assert_eq!(json.matches("\"passkey\"").count(), 1);
        let back: ItemPlaintext = serde_json::from_str(&json).unwrap();
        assert!(back.passkey.is_some());
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
    fn stores_a_canonical_one_time_password() {
        let keyring = unlocked();
        let (vault, _) = keyring.create_vault("Personal").unwrap();
        let mut fields = login();
        fields.totp = " jbsw y3dp ehpk 3pxp ".into();
        let item = keyring.seal_item(&vault.id, None, fields).unwrap();
        let opened = keyring.open_item(&vault.id, &item).unwrap();
        assert_eq!(opened.totp, "otpauth://totp/?secret=JBSWY3DPEHPK3PXP");
        assert!(ItemSummary::from(&opened).has_totp);
        let wire = serde_json::to_string(&item).unwrap();
        assert!(!wire.contains("JBSW"));

        let mut bad = login();
        bad.totp = "not a key!".into();
        assert!(matches!(
            keyring.seal_item(&vault.id, None, bad),
            Err(VaultError::OneTimePassword(_))
        ));
    }

    #[test]
    fn opens_items_saved_before_one_time_passwords() {
        let old = r#"{"v":1,"kind":"login","title":"t","username":"u","password":"p","urls":[],"notes":""}"#;
        let parsed: ItemPlaintext = serde_json::from_str(old).unwrap();
        assert_eq!(parsed.fields.totp, "");
        assert!(!ItemSummary::from(&parsed.fields).has_totp);
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

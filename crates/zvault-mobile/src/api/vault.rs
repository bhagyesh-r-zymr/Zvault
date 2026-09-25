//! Reading vaults, items, projects and secrets.

use crate::keyring::EntryKind;
use crate::records::{
    self, Blob, EnvironmentRecord, ItemRecord, MemberWrap, ProjectRecord, VaultRecord,
};

use super::keyring;

pub struct VaultSummary {
    pub id: String,
    pub name: String,
}

/// What the item list shows. The password stays in Rust.
pub struct ItemSummary {
    pub title: String,
    pub username: String,
    pub url: Option<String>,
    pub has_totp: bool,
    pub has_passkey: bool,
}

/// Everything in a login item, for the detail screen.
pub struct ItemDetail {
    pub title: String,
    pub username: String,
    pub password: String,
    pub urls: Vec<String>,
    pub notes: String,
    pub has_totp: bool,
    pub passkey: Option<PasskeyDetail>,
}

/// An item's passkey without its private key, which stays in Rust.
pub struct PasskeyDetail {
    /// The website's domain, such as `github.com`.
    pub rp_id: String,
    pub user_name: String,
    pub credential_id: String,
    /// Base64url SubjectPublicKeyInfo.
    pub public_key: String,
    /// Unix seconds.
    pub created_at: i64,
}

pub struct OneTimeCode {
    pub code: String,
    pub period: u32,
    /// Seconds until the next code.
    pub remaining: u32,
}

pub struct EnvironmentView {
    /// `EnvironmentMeta` as JSON.
    pub meta_json: String,
    /// Whether this account holds the key to read values.
    pub unlocked: bool,
}

pub fn vault_open(record_json: String) -> anyhow::Result<VaultSummary> {
    let record: VaultRecord = records::parse(&record_json)?;
    let (id, name) = keyring().open_vault(&record)?;
    Ok(VaultSummary { id, name })
}

pub fn item_summary(vault_id: String, record_json: String) -> anyhow::Result<ItemSummary> {
    let record: ItemRecord = records::parse(&record_json)?;
    let f = keyring().open_item(&vault_id, &record)?;
    Ok(ItemSummary {
        title: f.title.clone(),
        username: f.username.clone(),
        url: f.urls.first().cloned(),
        has_totp: !f.totp.is_empty(),
        has_passkey: f.passkey.is_some(),
    })
}

pub fn item_open(vault_id: String, record_json: String) -> anyhow::Result<ItemDetail> {
    let record: ItemRecord = records::parse(&record_json)?;
    let f = keyring().open_item(&vault_id, &record)?;
    Ok(ItemDetail {
        title: f.title.clone(),
        username: f.username.clone(),
        password: f.password.clone(),
        urls: f.urls.clone(),
        notes: f.notes.clone(),
        has_totp: !f.totp.is_empty(),
        passkey: f
            .passkey
            .as_ref()
            .map(|p| -> anyhow::Result<PasskeyDetail> {
                Ok(PasskeyDetail {
                    rp_id: p.rp_id.clone(),
                    user_name: p.user_name.clone(),
                    credential_id: p.credential_id.clone(),
                    public_key: p.public_key()?,
                    created_at: p.created_at,
                })
            })
            .transpose()?,
    })
}

/// Signs a fresh WebAuthn challenge with the item's passkey and verifies it
/// with the public key, as the website would.
pub fn item_passkey_test(vault_id: String, record_json: String) -> anyhow::Result<()> {
    let record: ItemRecord = records::parse(&record_json)?;
    let f = keyring().open_item(&vault_id, &record)?;
    let passkey = f
        .passkey
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("This item has no passkey."))?;
    passkey.self_test()?;
    Ok(())
}

/// The item's current one-time password, or None if it has none.
pub fn item_totp(
    vault_id: String,
    record_json: String,
    unix_secs: i64,
) -> anyhow::Result<Option<OneTimeCode>> {
    let record: ItemRecord = records::parse(&record_json)?;
    let f = keyring().open_item(&vault_id, &record)?;
    if f.totp.is_empty() {
        return Ok(None);
    }
    let c = zvault_otp::Totp::parse(&f.totp)?.code_at(u64::try_from(unix_secs)?);
    Ok(Some(OneTimeCode {
        code: c.code,
        period: u32::try_from(c.period)?,
        remaining: u32::try_from(c.remaining)?,
    }))
}

/// Opens a project and returns its `ProjectMeta` as JSON. `member_wrap_json`
/// is `projectKey` from `GET /access/projects/:id/keys/me` for a shared project.
pub fn project_open(
    record_json: String,
    member_wrap_json: Option<String>,
) -> anyhow::Result<String> {
    let record: ProjectRecord = records::parse(&record_json)?;
    let wrap: Option<MemberWrap> = member_wrap_json
        .as_deref()
        .map(records::parse)
        .transpose()?;
    Ok(keyring().open_project(&record, wrap.as_ref())?.to_string())
}

pub fn environment_open(
    project_id: String,
    entry_json: String,
    member_wrap_json: Option<String>,
) -> anyhow::Result<EnvironmentView> {
    let record: EnvironmentRecord = records::parse(&entry_json)?;
    let wrap: Option<MemberWrap> = member_wrap_json
        .as_deref()
        .map(records::parse)
        .transpose()?;
    let (meta, unlocked) = keyring().open_environment(&project_id, &record, wrap.as_ref())?;
    Ok(EnvironmentView {
        meta_json: meta.to_string(),
        unlocked,
    })
}

/// Opens a folder's or secret's metadata. `kind` is `folder` or `secret`.
pub fn entry_open(
    project_id: String,
    kind: String,
    id: String,
    blob_json: String,
) -> anyhow::Result<String> {
    let kind = match kind.as_str() {
        "folder" => EntryKind::Folder,
        "secret" => EntryKind::Secret,
        _ => anyhow::bail!("invalid record"),
    };
    let blob: Blob = records::parse(&blob_json)?;
    Ok(keyring()
        .open_entry(&project_id, kind, &id, &blob)?
        .to_string())
}

/// Decrypts one secret value to show or copy.
pub fn secret_value_open(
    project_id: String,
    secret_id: String,
    environment_id: String,
    blob_json: String,
) -> anyhow::Result<String> {
    let blob: Blob = records::parse(&blob_json)?;
    let value = keyring().open_secret_value(&project_id, &secret_id, &environment_id, &blob)?;
    Ok(value.as_str().to_owned())
}

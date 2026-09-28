//! Secret sync commands: pushing an environment's secrets to GitHub Actions
//! or AWS Secrets Manager from this Mac.
//!
//! The UI names what to push by ciphertext (as the project sync holds it);
//! values are decrypted here with the environment key and go straight to the
//! provider, so they never reach the web view or the Zvault server. Provider
//! credentials live in the login keychain and never leave Rust either: the
//! UI only learns who they belong to.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zvault_sync::{Credential, Item, Report, Target};

use crate::auth::blocking;
use crate::vault::{Blob, Keyring};

/// One variable to push, as its ciphertext.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    /// The variable name at the provider (the secret's key).
    pub name: String,
    pub secret_id: String,
    /// The environment the value is sealed in: the target's own, or the one it
    /// falls back to.
    pub environment_id: String,
    pub encrypted_value: Blob,
}

/// Who the saved credentials belong to, per provider.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub github: Option<String>,
    pub aws: Option<String>,
}

/// A credential with the identity it was verified as.
#[derive(Serialize, Deserialize)]
struct Saved {
    credential: Credential,
    who: String,
}

fn account(credential: &Credential) -> &'static str {
    match credential {
        Credential::Github { .. } => "github",
        Credential::Aws { .. } => "aws",
    }
}

fn load(provider: &str) -> Option<Saved> {
    let bytes = store::load(provider)?;
    serde_json::from_slice(&bytes).ok()
}

/// Which providers this Mac has credentials for. Reads the keychain, so the
/// first call after an update of an unsigned build may prompt.
#[tauri::command]
pub async fn sync_connections() -> Result<Connections, String> {
    blocking(|| {
        Ok(Connections {
            github: load("github").map(|s| s.who),
            aws: load("aws").map(|s| s.who),
        })
    })
    .await
}

/// Checks a credential with the provider, then keeps it in the keychain.
/// Returns who it belongs to.
#[tauri::command]
pub async fn sync_connect(credential: Credential) -> Result<String, String> {
    let who = zvault_sync::verify(&credential)
        .await
        .map_err(|e| e.to_string())?;
    let provider = account(&credential);
    let saved = Saved {
        credential,
        who: who.clone(),
    };
    let json = zeroize::Zeroizing::new(serde_json::to_vec(&saved).map_err(|e| e.to_string())?);
    blocking(move || store::save(provider, &json)).await?;
    Ok(who)
}

#[tauri::command]
pub async fn sync_disconnect(provider: String) -> Result<(), String> {
    if provider != "github" && provider != "aws" {
        return Err("unknown provider".into());
    }
    blocking(move || store::delete(&provider)).await
}

/// Pushes `items` to `target`. `previous` are the names the last push to it
/// wrote, so ones no longer in the environment can be removed.
#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    project_id: String,
    target: Target,
    items: Vec<SyncItem>,
    previous: Vec<String>,
) -> Result<Report, String> {
    target.validate().map_err(|e| e.to_string())?;
    let mut names = HashSet::new();
    for i in &items {
        if !names.insert(i.name.to_ascii_uppercase()) {
            return Err(format!(
                "two secrets are named {}; rename one to sync this environment",
                i.name
            ));
        }
    }
    let provider = match &target {
        Target::Github { .. } => "github",
        Target::Aws { .. } => "aws",
    };
    let saved = blocking(move || {
        load(provider).ok_or_else(|| {
            format!(
                "connect {} on this Mac first",
                if provider == "github" {
                    "GitHub"
                } else {
                    "AWS"
                }
            )
        })
    })
    .await?;

    // Decrypt everything before the first request so a lock mid-way can't
    // leave the target half-written.
    let keyring = app.state::<Keyring>();
    let plain = items
        .into_iter()
        .map(|i| {
            keyring
                .open_secret_value(
                    &project_id,
                    &i.secret_id,
                    &i.environment_id,
                    &i.encrypted_value,
                )
                .map(|value| Item {
                    name: i.name,
                    value,
                })
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    zvault_sync::push(&target, &saved.credential, &plain, &previous)
        .await
        .map_err(|e| e.to_string())
}

/// The keychain on macOS. Elsewhere (CI, Linux dev builds) credentials are
/// kept in memory until the app quits.
mod store {
    #[cfg(target_os = "macos")]
    pub use crate::platform::macos::sync_credentials::{delete, load, save};

    #[cfg(not(target_os = "macos"))]
    mod memory {
        use std::collections::HashMap;
        use std::sync::{Mutex, OnceLock};

        use zeroize::Zeroizing;

        pub fn map() -> &'static Mutex<HashMap<String, Zeroizing<Vec<u8>>>> {
            static MAP: OnceLock<Mutex<HashMap<String, Zeroizing<Vec<u8>>>>> = OnceLock::new();
            MAP.get_or_init(Mutex::default)
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn save(provider: &str, json: &[u8]) -> Result<(), String> {
        memory::map()
            .lock()
            .map_err(|_| "internal error".to_string())?
            .insert(provider.into(), zeroize::Zeroizing::new(json.to_vec()));
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn load(provider: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
        memory::map().lock().ok()?.get(provider).cloned()
    }

    #[cfg(not(target_os = "macos"))]
    pub fn delete(provider: &str) -> Result<(), String> {
        memory::map()
            .lock()
            .map_err(|_| "internal error".to_string())?
            .remove(provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_items_the_ui_sends() {
        let item: SyncItem = serde_json::from_value(serde_json::json!({
            "name": "DATABASE_URL",
            "secretId": "0f9e8a1c-4d5b-4c2a-9e1f-2b3c4d5e6f70",
            "environmentId": "1f9e8a1c-4d5b-4c2a-9e1f-2b3c4d5e6f70",
            "encryptedValue": { "v": 1, "alg": "xchacha20poly1305", "kid": "k", "nonce": "n", "ct": "c" }
        }))
        .unwrap();
        assert_eq!(item.name, "DATABASE_URL");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn keeps_credentials_until_disconnected() {
        let saved = Saved {
            credential: Credential::Github {
                token: "ghp_x".into(),
            },
            who: "octocat".into(),
        };
        store::save("github", &serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(load("github").unwrap().who, "octocat");
        store::delete("github").unwrap();
        assert!(load("github").is_none());
    }
}

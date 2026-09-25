//! Remembering the Secret Key on this Mac, as 1Password does: the person
//! types it (or picks their Emergency Kit) once, and every later sign-in asks
//! only for the master password.
//!
//! The key itself goes in the macOS Keychain. The account email and the
//! key's public id go in a plain file so the sign-in screen can say whose key
//! is saved without reading the Keychain item (which can prompt).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
use zvault_crypto::{SecretKey, normalize_account_id};

/// The account whose Secret Key is saved on this Mac. Holds no secret.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RememberedAccount {
    pub email: String,
    /// The public first part of the key, shown as `Z1-XXXXXX-•••••`.
    pub secret_key_id: String,
}

/// What the UI learns from an Emergency Kit the person picked.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedKit {
    email: Option<String>,
    secret_key_id: String,
}

/// A Secret Key read from an Emergency Kit, held until the sign-in it is for
/// succeeds and it moves to the Keychain.
#[derive(Default)]
pub struct KitImport(Mutex<Option<SecretKey>>);

fn lock(state: &KitImport) -> std::sync::MutexGuard<'_, Option<SecretKey>> {
    state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A second copy of a key, for handing to the sign-in without giving up ours.
fn copy(key: &SecretKey) -> SecretKey {
    SecretKey::parse(&key.to_display_string()).expect("a parsed key round-trips")
}

/// The Secret Key a sign-in for `email` should use when the person didn't
/// type one: a kit they just picked, else the one saved on this Mac.
/// May block on a Keychain prompt, so call it off the main thread.
pub(crate) fn key_for<R: Runtime>(app: &AppHandle<R>, email: &str) -> Option<SecretKey> {
    if let Some(key) = lock(&app.state::<KitImport>()).as_ref() {
        return Some(copy(key));
    }
    let saved = load(app)?;
    if saved.email != normalize_account_id(email) {
        return None;
    }
    let key = store::load(&saved.email)?;
    SecretKey::parse(&key).ok()
}

/// Saves `key` for `email` after a sign-in proved it right. Failing to save
/// only means the person types it again next time, so errors are dropped.
pub(crate) fn remember<R: Runtime>(app: &AppHandle<R>, email: &str, key: &SecretKey) {
    lock(&app.state::<KitImport>()).take();
    let account = RememberedAccount {
        email: normalize_account_id(email),
        secret_key_id: key.id().to_owned(),
    };
    // One account per Mac: saving another replaces the first.
    if let Some(old) = load(app).filter(|old| old.email != account.email) {
        let _ = store::delete(&old.email);
    }
    if store::save(&account.email, &key.to_display_string()).is_ok() {
        let _ = save(app, &account);
    }
}

/// The account whose Secret Key is saved here, if any.
#[tauri::command]
pub fn remembered_account<R: Runtime>(app: AppHandle<R>) -> Option<RememberedAccount> {
    load(&app)
}

/// Opens the person's Emergency Kit PDF and reads the Secret Key from it.
/// Resolves to None if they cancelled the dialog.
#[tauri::command]
pub async fn import_emergency_kit<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<ImportedKit>, String> {
    // Async commands run off the main thread, so blocking on the dialog is safe.
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Choose your Emergency Kit")
        .add_filter("PDF document", &["pdf"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let kit = read_kit(&path)?;
    let imported = ImportedKit {
        email: kit.email,
        secret_key_id: kit.secret_key.id().to_owned(),
    };
    *lock(&app.state::<KitImport>()) = Some(kit.secret_key);
    Ok(Some(imported))
}

/// Drops a kit the person picked but no longer wants to use.
#[tauri::command]
pub fn clear_emergency_kit_import(state: State<'_, KitImport>) {
    lock(&state).take();
}

/// Removes the saved Secret Key from this Mac.
#[tauri::command]
pub fn forget_secret_key<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    lock(&app.state::<KitImport>()).take();
    if let Some(account) = load(&app) {
        store::delete(&account.email)?;
    }
    if let Some(path) = path(&app) {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

const NOT_A_KIT: &str = "That file doesn't look like a Zvault Emergency Kit. \
     If you re-saved or printed it from another app, type the Secret Key instead.";

fn read_kit(path: &std::path::Path) -> Result<zvault_emergency_kit::ReadKit, String> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open that file: {e}"))?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(zvault_emergency_kit::MAX_KIT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Couldn't read that file: {e}"))?;
    zvault_emergency_kit::read(&bytes).ok_or_else(|| NOT_A_KIT.to_owned())
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remembered-account.json"))
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Option<RememberedAccount> {
    serde_json::from_slice(&std::fs::read(path(app)?).ok()?).ok()
}

fn save<R: Runtime>(app: &AppHandle<R>, account: &RememberedAccount) -> Result<(), String> {
    let path = path(app).ok_or("no app data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec(account).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Where the key itself is kept: the Keychain on macOS. Other platforms
/// (CI, Linux dev builds) don't remember it.
mod store {
    #[cfg(target_os = "macos")]
    pub use crate::platform::macos::secret_key::{delete, load, save};

    #[cfg(not(target_os = "macos"))]
    pub fn save(_account_id: &str, _key: &str) -> Result<(), String> {
        Err("not supported on this platform".into())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn load(_account_id: &str) -> Option<zeroize::Zeroizing<String>> {
        None
    }

    #[cfg(not(target_os = "macos"))]
    pub fn delete(_account_id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_kit_from_disk() {
        let key = SecretKey::parse("Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345").unwrap();
        let pdf = zvault_emergency_kit::Kit {
            email: "ada@example.com",
            sign_in_url: "https://my.zvault.app",
            secret_key: &key,
            created_on: zvault_emergency_kit::Date::today(),
        }
        .render()
        .unwrap();
        let path = std::env::temp_dir().join(format!("zvault-read-kit-{}.pdf", std::process::id()));
        std::fs::write(&path, &*pdf).unwrap();
        let read = read_kit(&path);
        std::fs::write(&path, b"%PDF-1.7 compressed").unwrap();
        let not_a_kit = read_kit(&path);
        std::fs::remove_file(&path).unwrap();

        let read = read.unwrap();
        assert_eq!(read.secret_key.id(), "ABC123");
        assert_eq!(read.email.as_deref(), Some("ada@example.com"));
        assert_eq!(not_a_kit.err().as_deref(), Some(NOT_A_KIT));
    }

    #[test]
    fn copies_keep_the_whole_key() {
        let key = SecretKey::generate().unwrap();
        assert_eq!(*copy(&key).to_display_string(), *key.to_display_string());
    }
}

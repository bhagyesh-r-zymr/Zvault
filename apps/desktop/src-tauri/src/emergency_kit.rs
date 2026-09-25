//! Saving the Emergency Kit. The PDF is rendered here in Rust and written
//! straight to the file the person picks in a native save dialog, so the
//! Secret Key never passes through the web view or the network.

use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use zvault_crypto::SecretKey;
use zvault_emergency_kit::{Date, FILE_NAME, Kit};

/// Printed on the kit. Override at build time for staging builds.
const SIGN_IN_URL: &str = match option_env!("ZVAULT_SIGN_IN_URL") {
    Some(url) => url,
    None => "https://my.zvault.app",
};

/// The Secret Key waiting to be saved to an Emergency Kit. Sign-up puts the
/// new key here with [`stage_secret_key`] once the account exists; the UI
/// then offers the download, and [`discard_emergency_kit`] drops (and
/// zeroizes) the key once the person confirms they saved it.
#[derive(Default)]
pub struct PendingKit(Mutex<Option<SecretKey>>);

/// Makes `key` available to [`save_emergency_kit`], replacing any earlier one.
pub fn stage_secret_key<R: Runtime>(app: &AppHandle<R>, key: SecretKey) {
    *lock(&app.state::<PendingKit>()) = Some(key);
}

fn lock(state: &PendingKit) -> std::sync::MutexGuard<'_, Option<SecretKey>> {
    // A panic while holding the lock can't leave the Option half-written.
    state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether a Secret Key is waiting to be saved.
#[tauri::command]
pub fn emergency_kit_pending(state: State<'_, PendingKit>) -> bool {
    lock(&state).is_some()
}

/// Asks where to save the kit and writes it. Returns `false` if the person
/// cancelled the dialog. The key stays staged so they can save another copy.
#[tauri::command]
pub async fn save_emergency_kit<R: Runtime>(
    app: AppHandle<R>,
    email: String,
) -> Result<bool, String> {
    // Render first so a bad email fails before any dialog appears.
    let pdf = {
        let state = app.state::<PendingKit>();
        let guard = lock(&state);
        let key = guard.as_ref().ok_or("There's no new Secret Key to save.")?;
        Kit {
            email: &email,
            sign_in_url: SIGN_IN_URL,
            secret_key: key,
            created_on: Date::today(),
        }
        .render()
        .map_err(|e| e.to_string())?
    };

    // Async commands run off the main thread, so blocking on the dialog is safe.
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Save your Emergency Kit")
        .set_file_name(FILE_NAME)
        .add_filter("PDF document", &["pdf"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    write_private(&path, &pdf).map_err(|e| format!("Couldn't save the Emergency Kit: {e}"))?;
    Ok(true)
}

/// Forgets the staged Secret Key once the person has saved their kit.
#[tauri::command]
pub fn discard_emergency_kit(state: State<'_, PendingKit>) {
    lock(&state).take();
}

/// Writes `bytes` readable only by the current user.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    // `mode` only applies to new files; tighten an overwritten one too.
    #[cfg(unix)]
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_url_is_printable() {
        let key = SecretKey::generate().unwrap();
        Kit {
            email: "ada@example.com",
            sign_in_url: SIGN_IN_URL,
            secret_key: &key,
            created_on: Date::today(),
        }
        .render()
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saved_kits_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let path = std::env::temp_dir().join(format!("zvault-kit-{}.pdf", std::process::id()));
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"%PDF").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(mode & 0o777, 0o600);
    }
}

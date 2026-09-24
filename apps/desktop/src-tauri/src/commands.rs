//! Lock, Touch ID and clipboard commands exposed to the web UI.
//!
//! The UI never receives key material: it asks Rust to unlock, lock or copy,
//! and learns the result from `lock_status` and the `vault://locked` event.

use std::path::PathBuf;
use std::time::{Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zvault_crypto::SymmetricKey;

use crate::autolock::{self, AppState};
use crate::biometric::{self, BiometricError};
use crate::session::{LockReason, LockSettings, UnlockMethod};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchIdStatus {
    available: bool,
    enrolled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    locked: bool,
    account_id: Option<String>,
    unlock_method: Option<UnlockMethod>,
    settings: LockSettings,
    touch_id: TouchIdStatus,
}

#[tauri::command]
pub fn lock_status(app: AppHandle, state: State<'_, AppState>) -> LockStatus {
    let session = state.session();
    LockStatus {
        locked: session.is_locked(),
        account_id: session.account_id().map(str::to_owned),
        unlock_method: session.method(),
        settings: session.settings(),
        touch_id: TouchIdStatus {
            available: biometric::available(),
            enrolled: enrolled_account(&app).is_some(),
        },
    }
}

#[tauri::command]
pub fn lock_vault(app: AppHandle) {
    autolock::lock(&app, LockReason::Manual);
}

/// Called (throttled) by the UI on keyboard and pointer input.
#[tauri::command]
pub fn report_activity(state: State<'_, AppState>) {
    state.session().touch(Instant::now());
}

#[tauri::command]
pub fn set_lock_settings(
    state: State<'_, AppState>,
    settings: LockSettings,
) -> Result<LockSettings, String> {
    let mut session = state.session();
    session.set_settings(settings).map_err(str::to_owned)?;
    Ok(session.settings())
}

/// Copies a secret and clears it after the configured delay. Returns the
/// delay in seconds so the UI can say when.
#[tauri::command]
pub fn copy_secret(state: State<'_, AppState>, text: String) -> Result<u32, String> {
    let settings = {
        let session = state.session();
        if session.is_locked() {
            return Err("vault is locked".into());
        }
        session.settings()
    };
    state
        .clipboard
        .copy_secret(&text, settings.clipboard_clear_after())
        .map_err(|e| e.to_string())?;
    Ok(settings.clipboard_clear_secs)
}

/// Stores the current unlock key behind Touch ID.
#[tauri::command]
pub fn enable_touch_id(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let account_id = {
        let session = state.session();
        let (account_id, key, verified_at) = session
            .key_for_enrollment()
            .ok_or("unlock with your master password first")?;
        if !biometric::is_fresh(verified_at, SystemTime::now()) {
            return Err(BiometricError::Expired.to_string());
        }
        biometric::store(account_id, key, verified_at).map_err(|e| e.to_string())?;
        account_id.to_owned()
    };
    set_enrolled_account(&app, Some(&account_id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn disable_touch_id(app: AppHandle) -> Result<(), String> {
    if let Some(account_id) = enrolled_account(&app) {
        biometric::delete(&account_id).map_err(|e| e.to_string())?;
    }
    set_enrolled_account(&app, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unlock_with_touch_id(app: AppHandle) -> Result<(), String> {
    let account_id = enrolled_account(&app).ok_or(BiometricError::NotEnrolled.to_string())?;

    // The Keychain read blocks on the Touch ID prompt.
    let lookup = account_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || biometric::load(&lookup))
        .await
        .map_err(|e| e.to_string())?;

    let record = match result {
        Ok(record) => record,
        Err(BiometricError::NotEnrolled) => {
            // Fingerprints changed or the passcode was removed, and macOS
            // deleted the item. Forget the enrollment too.
            let _ = set_enrolled_account(&app, None);
            return Err(BiometricError::NotEnrolled.to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    if !biometric::is_fresh(record.password_verified_at, SystemTime::now()) {
        let _ = biometric::delete(&account_id);
        let _ = set_enrolled_account(&app, None);
        return Err(BiometricError::Expired.to_string());
    }

    let keyset = crate::auth::copy_key(&record.key);
    app.state::<AppState>().session().unlock(
        account_id.clone(),
        record.key,
        UnlockMethod::TouchId,
        record.password_verified_at,
        Instant::now(),
    );
    app.state::<crate::Keyring>()
        .unlock(crate::auth::copy_key(&keyset));
    crate::auth::restore(&app, account_id, keyset);
    Ok(())
}

/// Starts a session after the master password was verified, and refreshes the
/// Touch ID record so quick unlock's expiry restarts. Sign-in calls this.
pub fn unlocked_with_password(
    app: &AppHandle,
    state: &AppState,
    account_id: String,
    key: SymmetricKey,
) {
    let now = SystemTime::now();
    let mut session = state.session();
    if enrolled_account(app).as_deref() == Some(account_id.as_str()) {
        // Failing to refresh just means Touch ID expires on schedule.
        let _ = biometric::store(&account_id, &key, now);
    }
    session.unlock(
        account_id,
        key,
        UnlockMethod::MasterPassword,
        now,
        Instant::now(),
    );
}

// The enrolled account id is kept in a plain file so the lock screen can offer
// Touch ID without touching the Keychain (reading the item would prompt). It
// holds no secret; the Keychain item stays the source of truth.

fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("touch-id-account"))
}

/// The account whose unlock key is behind Touch ID, if any. Agent approvals
/// use it to ask for a fingerprint.
pub(crate) fn touch_id_account(app: &AppHandle) -> Option<String> {
    enrolled_account(app)
}

fn enrolled_account(app: &AppHandle) -> Option<String> {
    if !biometric::available() {
        return None;
    }
    let id = std::fs::read_to_string(marker_path(app)?).ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| id.to_owned())
}

fn set_enrolled_account(app: &AppHandle, account_id: Option<&str>) -> std::io::Result<()> {
    let path = marker_path(app).ok_or_else(|| std::io::Error::other("no app data directory"))?;
    match account_id {
        Some(id) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, id)
        }
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

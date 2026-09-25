//! App updates from GitHub Releases, through the Tauri updater plugin.
//!
//! Release builds get the updater public key from the release workflow (see
//! `.github/workflows/release-macos.yml`) and check
//! `releases/latest/download/latest.json`. The update is a signed
//! `Zvault.app.tar.gz`; the plugin checks its signature before replacing the
//! app. Updating the app also updates the `zv` inside it, which is what the
//! "Install command-line tool" link points at.
//!
//! Dev builds and builds without a key never check.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept until the user installs it.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    /// Whether this build can update itself at all.
    enabled: bool,
    /// A newer version, when there is one.
    available: Option<AvailableUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    !cfg!(debug_assertions)
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u.get("pubkey"))
            .and_then(|k| k.as_str())
            .is_some_and(|k| !k.trim().is_empty())
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    if !enabled(&app) {
        return Ok(UpdateCheck {
            current_version,
            enabled: false,
            available: None,
        });
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;
    let available = update.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update;
    Ok(UpdateCheck {
        current_version,
        enabled: true,
        available,
    })
}

/// Downloads the update found by `update_check`, installs it and restarts
/// Zvault, which locks it. Emits `update://progress` while downloading.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("No update to install. Check for updates first.")?;
    let emitter = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update://progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("Could not install the update: {e}"))?;
    app.restart()
}

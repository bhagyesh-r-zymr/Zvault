//! Tauri shell for Zvault. Commands exposed to the web UI live here and call
//! into `zvault-crypto`; secrets never cross into JavaScript unless the UI
//! must display them (for example the Secret Key on the Emergency Kit).

mod emergency_kit;

use serde::Serialize;

pub use emergency_kit::stage_secret_key;

/// Must match `CRYPTO_VERSION` in `@zvault/shared`.
const CRYPTO_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInfo {
    crypto_version: u32,
    aead: &'static str,
    kdf: &'static str,
}

#[tauri::command]
fn core_info() -> CoreInfo {
    CoreInfo {
        crypto_version: CRYPTO_VERSION,
        aead: "xchacha20poly1305",
        kdf: "argon2id + secret key (2SKD)",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(emergency_kit::PendingKit::default())
        .invoke_handler(tauri::generate_handler![
            core_info,
            emergency_kit::emergency_kit_pending,
            emergency_kit::save_emergency_kit,
            emergency_kit::discard_emergency_kit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zvault");
}

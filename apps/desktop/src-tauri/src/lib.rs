//! Tauri shell for Zvault. Commands exposed to the web UI live here and call
//! into `zvault-crypto`; secrets never cross into JavaScript unless the UI
//! must display them (for example the Secret Key on the Emergency Kit).

mod auth;
mod emergency_kit;
mod vault;

use std::sync::Mutex;

use serde::Serialize;

pub(crate) use auth::CRYPTO_VERSION;
pub use emergency_kit::stage_secret_key;
pub use vault::Keyring;

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
        .manage(Mutex::new(auth::AuthState::default()))
        .manage(emergency_kit::PendingKit::default())
        .manage(Keyring::default())
        .invoke_handler(tauri::generate_handler![
            core_info,
            auth::create_account,
            auth::login_prove,
            auth::login_finish,
            auth::lock,
            auth::unlocked,
            emergency_kit::emergency_kit_pending,
            emergency_kit::save_emergency_kit,
            emergency_kit::discard_emergency_kit,
            vault::vault_create,
            vault::vault_open,
            vault::vault_lock,
            vault::item_seal,
            vault::item_open,
            vault::item_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zvault");
}

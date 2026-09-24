//! Tauri shell for Zvault. Commands exposed to the web UI live here and call
//! into `zvault-crypto`; secrets never cross into JavaScript unless the UI
//! must display them (for example the Secret Key on the Emergency Kit).

mod generator;

use serde::Serialize;

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
        .invoke_handler(tauri::generate_handler![
            core_info,
            generator::generate_password,
            generator::generate_passphrase,
            generator::check_password_strength,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zvault");
}

//! Tauri shell for Zvault. Commands exposed to the web UI live here and call
//! into `zvault-crypto`; secrets never cross into JavaScript unless the UI
//! must display them (for example the Secret Key on the Emergency Kit).

mod agents;
mod auth;
mod autolock;
mod biometric;
mod cli_install;
mod clipboard;
mod commands;
mod emergency_kit;
mod generator;
mod otp;
mod pairing;
mod platform;
mod projects;
mod session;
mod sharing;
mod team;
mod updater;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(auth::AuthState::default()))
        .manage(emergency_kit::PendingKit::default())
        .manage(Keyring::default())
        .manage(autolock::AppState::new())
        .manage(agents::AgentHub::default())
        .manage(updater::PendingUpdate::default())
        .manage(pairing::PendingPairing::default())
        .setup(|app| {
            autolock::start(app.handle());
            agents::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_info,
            auth::create_account,
            auth::login_prove,
            auth::login_verify_server,
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
            vault::item_totp_code,
            otp::otp_parse,
            pairing::pairing_begin,
            pairing::pairing_qr,
            pairing::pairing_code,
            pairing::pairing_grant,
            pairing::pairing_cancel,
            otp::otp_scan_image,
            otp::otp_scan_screen,
            projects::project_create,
            projects::project_open,
            projects::environment_open,
            projects::environment_seal,
            projects::entry_seal,
            projects::entry_open,
            projects::secret_value_seal,
            projects::secret_value_open,
            generator::generate_password,
            generator::generate_passphrase,
            generator::check_password_strength,
            commands::lock_status,
            commands::lock_vault,
            commands::report_activity,
            commands::set_lock_settings,
            commands::copy_secret,
            commands::enable_touch_id,
            commands::disable_touch_id,
            commands::unlock_with_touch_id,
            sharing::share_link_create,
            sharing::sharing_identity,
            sharing::sharing_fingerprint,
            sharing::share_seal_to,
            sharing::share_open,
            team::project_key_wrap,
            team::environment_key_wrap,
            team::environment_rotate,
            team::environment_rotate_commit,
            team::access_release_seal,
            team::access_release_open,
            agents::agent_access_status,
            agents::agent_list,
            agents::agent_update,
            agents::agent_unpair,
            agents::agent_activity,
            agents::agent_approval_respond,
            agents::agent_pairing_respond,
            agents::agent_resolve_respond,
            agents::agent_list_respond,
            agents::agent_write_respond,
            cli_install::cli_status,
            cli_install::cli_install,
            updater::update_check,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zvault");
}

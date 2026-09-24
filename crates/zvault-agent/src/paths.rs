//! Where the app listens for `zv`. Both sides must agree, so this is shared.

use std::path::PathBuf;

/// Overrides the socket path, for tests and unusual setups.
pub const SOCKET_ENV: &str = "ZV_SOCKET";
pub const SOCKET_NAME: &str = "agent.sock";
/// Matches `identifier` in the desktop app's `tauri.conf.json`.
pub const APP_IDENTIFIER: &str = "com.zvault.desktop";

/// The desktop app's data directory, as Tauri's `app_data_dir` computes it.
pub fn app_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        Some(
            home.join("Library/Application Support")
                .join(APP_IDENTIFIER),
        )
    } else {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        Some(base.join(APP_IDENTIFIER))
    }
}

/// The socket `zv` connects to.
pub fn socket_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(SOCKET_ENV) {
        return Some(PathBuf::from(p));
    }
    app_data_dir().map(|d| d.join(SOCKET_NAME))
}

//! Registers `zv` as the browser extension's native messaging host.
//!
//! Chrome-family browsers find a native host through a small JSON manifest in
//! their `NativeMessagingHosts` folder, naming the program to start and the
//! one extension allowed to start it. Release builds ship `zv` inside
//! Zvault.app, so on every launch we write that manifest for each browser
//! that is installed, pointing at this app's copy. The manifest only lets the
//! Zvault extension start `zv`; what the extension may then do is decided
//! over the agent socket like any other `zv` request.

use std::path::{Path, PathBuf};

use serde::Serialize;
use zvault_agent::browser;

/// Browsers we register with: a display name and their profile folder,
/// relative to the home directory.
#[cfg(target_os = "macos")]
const BROWSERS: &[(&str, &str)] = &[
    ("Google Chrome", "Library/Application Support/Google/Chrome"),
    (
        "Chrome Beta",
        "Library/Application Support/Google/Chrome Beta",
    ),
    (
        "Chrome Canary",
        "Library/Application Support/Google/Chrome Canary",
    ),
    ("Chromium", "Library/Application Support/Chromium"),
    (
        "Brave",
        "Library/Application Support/BraveSoftware/Brave-Browser",
    ),
    (
        "Microsoft Edge",
        "Library/Application Support/Microsoft Edge",
    ),
    ("Vivaldi", "Library/Application Support/Vivaldi"),
    ("Arc", "Library/Application Support/Arc/User Data"),
];

#[cfg(not(target_os = "macos"))]
const BROWSERS: &[(&str, &str)] = &[
    ("Google Chrome", ".config/google-chrome"),
    ("Chromium", ".config/chromium"),
    ("Brave", ".config/BraveSoftware/Brave-Browser"),
    ("Microsoft Edge", ".config/microsoft-edge"),
    ("Vivaldi", ".config/vivaldi"),
];

#[derive(Serialize)]
struct HostManifest<'a> {
    name: &'a str,
    description: &'a str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_origins: Vec<String>,
}

fn manifest(zv: &Path) -> Option<Vec<u8>> {
    let manifest = HostManifest {
        name: browser::HOST_NAME,
        description: "Zvault: fills logins from the Zvault app",
        path: zv.to_str()?,
        kind: "stdio",
        allowed_origins: vec![browser::extension_origin()],
    };
    serde_json::to_vec_pretty(&manifest).ok()
}

/// The folders of the browsers installed for this user.
fn installed(home: &Path) -> Vec<(&'static str, PathBuf)> {
    BROWSERS
        .iter()
        .map(|(name, dir)| (*name, home.join(dir)))
        .filter(|(_, dir)| dir.is_dir())
        .collect()
}

fn host_file(profile_dir: &Path) -> PathBuf {
    profile_dir
        .join("NativeMessagingHosts")
        .join(format!("{}.json", browser::HOST_NAME))
}

/// Writes the manifest into each installed browser whose copy is missing or
/// different. Returns the browsers that now have it.
fn install_into(home: &Path, zv: &Path) -> Vec<&'static str> {
    let Some(json) = manifest(zv) else {
        return vec![];
    };
    installed(home)
        .into_iter()
        .filter(|(_, dir)| {
            let file = host_file(dir);
            if std::fs::read(&file).is_ok_and(|b| b == json) {
                return true;
            }
            file.parent()
                .is_some_and(|d| std::fs::create_dir_all(d).is_ok())
                && std::fs::write(&file, &json).is_ok()
        })
        .map(|(name, _)| name)
        .collect()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Registers this app's `zv` with the installed browsers. Does nothing in
/// development builds, which do not ship `zv`.
pub fn register() {
    let (Some(home), Some(zv)) = (home(), crate::cli_install::bundled()) else {
        return;
    };
    std::thread::spawn(move || {
        install_into(&home, &zv);
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionStatus {
    /// Whether this build ships `zv`, which the extension needs.
    bundled: bool,
    /// Browsers that can start `zv` for the extension.
    browsers: Vec<&'static str>,
    extension_id: &'static str,
}

#[tauri::command]
pub fn browser_extension_status() -> BrowserExtensionStatus {
    let zv = crate::cli_install::bundled();
    let browsers = match (home(), &zv) {
        (Some(home), Some(zv)) => install_into(&home, zv),
        _ => vec![],
    };
    BrowserExtensionStatus {
        bundled: zv.is_some(),
        browsers,
        extension_id: browser::EXTENSION_ID,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_only_with_installed_browsers_and_only_our_extension() {
        let home = std::env::temp_dir().join(format!("zvault-browsers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let (name, dir) = BROWSERS[0];
        std::fs::create_dir_all(home.join(dir)).unwrap();
        let zv = Path::new("/Applications/Zvault.app/Contents/MacOS/zv");

        assert_eq!(install_into(&home, zv), vec![name]);
        let file = host_file(&home.join(dir));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(written["name"], "com.zvault.browser");
        assert_eq!(written["path"], zv.to_str().unwrap());
        assert_eq!(written["type"], "stdio");
        assert_eq!(
            written["allowed_origins"],
            serde_json::json!(["chrome-extension://koohciaalhgmbjmpnenehibgcfndkgdf/"])
        );
        // Browsers that are not installed are left alone.
        let (_, other) = BROWSERS[1];
        assert!(!home.join(other).exists());
        // Running again changes nothing.
        assert_eq!(install_into(&home, zv), vec![name]);
        let _ = std::fs::remove_dir_all(&home);
    }
}

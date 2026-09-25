//! `zv update`: replaces this `zv` with the one from the latest GitHub Release.
//!
//! Releases carry `zv-macos-universal` and `zv-macos-universal.sig`, a
//! minisign signature made with the same key that signs the app's updates.
//! The signature's trusted comment names the file it was made for,
//! `zv-v<version>-macos-universal`, so an old but genuine build can't be
//! passed off as a newer one.
//!
//! A `zv` inside Zvault.app is left alone: the app's own updater replaces it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

/// This build's version. Release builds set `ZV_VERSION` from the release tag.
pub const VERSION: &str = match option_env!("ZV_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

/// The updater public key (base64 of a minisign public key file), set by the
/// release build. Builds without it cannot update themselves.
const PUBKEY: Option<&str> = match option_env!("ZVAULT_UPDATER_PUBKEY") {
    Some(k) if !k.is_empty() => Some(k),
    _ => None,
};

const RELEASES: &str = "https://github.com/bhagyesh-r-zymr/Zvault/releases";
const ASSET: &str = "zv-macos-universal";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("this zv was built without an update key; download it again from {RELEASES}/latest")]
    NoKey,
    #[error("zv update only works on macOS for now")]
    Unsupported,
    #[error("could not download {0}: {1}")]
    Download(String, String),
    #[error("the latest release looks malformed: {0}")]
    BadRelease(String),
    #[error("the download failed its signature check ({0}); zv was not changed")]
    BadSignature(String),
    #[error("{dir} is not writable; run `sudo zv update`")]
    NotWritable { dir: String },
    #[error("could not replace {path}: {source}")]
    Replace {
        path: String,
        source: std::io::Error,
    },
}

/// A version as three numbers. Anything after them (`-beta`) is ignored.
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Whether `exe` is the copy inside an app bundle, which the app updates.
fn inside_app_bundle(exe: &Path) -> bool {
    exe.to_string_lossy().contains(".app/Contents/MacOS/")
}

fn fetch(url: &str) -> Result<Vec<u8>, UpdateError> {
    let out = Command::new("curl")
        .args([
            "-fsSL",
            "--proto",
            "=https",
            "--tlsv1.2",
            "--max-time",
            "300",
        ])
        .arg(url)
        .output()
        .map_err(|e| UpdateError::Download(url.into(), e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(UpdateError::Download(url.into(), err));
    }
    Ok(out.stdout)
}

/// The newest release's version, from the app updater's `latest.json`.
fn latest_version() -> Result<String, UpdateError> {
    #[derive(serde::Deserialize)]
    struct Latest {
        version: String,
    }
    let body = fetch(&format!("{RELEASES}/latest/download/latest.json"))?;
    let latest: Latest =
        serde_json::from_slice(&body).map_err(|e| UpdateError::BadRelease(e.to_string()))?;
    let version = latest.version.trim_start_matches('v').to_string();
    parse_version(&version)
        .map(|_| version.clone())
        .ok_or(UpdateError::BadRelease(format!("version {version:?}")))
}

fn b64_text(s: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Checks `data` against `sig` (a `.sig` file as the Tauri CLI writes it) and
/// that the signature was made for `zv-v<version>-macos-universal`.
fn verify(data: &[u8], sig: &str, pubkey: &str, version: &str) -> Result<(), UpdateError> {
    let bad = UpdateError::BadSignature;
    let key = PublicKey::decode(&b64_text(pubkey).map_err(bad)?)
        .map_err(|e| bad(format!("public key: {e}")))?;
    let sig = Signature::decode(&b64_text(sig).map_err(bad)?).map_err(|e| bad(e.to_string()))?;
    key.verify(data, &sig, false)
        .map_err(|e| bad(e.to_string()))?;
    // Only trust the comment once the signature over it has been checked.
    let expected = format!("file:zv-v{version}-macos-universal");
    if !sig.trusted_comment().split('\t').any(|f| f == expected) {
        return Err(bad(format!("it was not signed as zv {version}")));
    }
    Ok(())
}

/// Writes `data` next to `exe` and renames it over `exe`, so a running `zv`
/// keeps its old file and the new one appears all at once.
fn replace(exe: &Path, data: &[u8]) -> Result<(), UpdateError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let dir = exe.parent().unwrap_or(Path::new("/"));
    let tmp = dir.join(format!(".zv-update-{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)?;
        f.write_all(data)?;
        // `mode` above is filtered by the umask; the binary must be runnable.
        f.set_permissions(std::fs::Permissions::from_mode(0o755))?;
        f.sync_all()?;
        std::fs::rename(&tmp, exe)
    };
    write().map_err(|source| {
        let _ = std::fs::remove_file(&tmp);
        if source.kind() == std::io::ErrorKind::PermissionDenied {
            UpdateError::NotWritable {
                dir: dir.display().to_string(),
            }
        } else {
            UpdateError::Replace {
                path: exe.display().to_string(),
                source,
            }
        }
    })
}

fn current_exe() -> Result<PathBuf, UpdateError> {
    let exe = std::env::current_exe().and_then(|p| p.canonicalize());
    exe.map_err(|source| UpdateError::Replace {
        path: "zv".into(),
        source,
    })
}

/// Runs `zv update`. With `check`, only reports whether an update exists.
pub fn run(check: bool) -> Result<u8, UpdateError> {
    let exe = current_exe()?;
    if inside_app_bundle(&exe) {
        println!(
            "This zv comes with the Zvault app, which keeps it up to date. \
             Zvault checks for updates when it starts, or in Settings > Account."
        );
        return Ok(0);
    }
    if !cfg!(target_os = "macos") {
        return Err(UpdateError::Unsupported);
    }
    let pubkey = PUBKEY.ok_or(UpdateError::NoKey)?;

    let latest = latest_version()?;
    if !is_newer(&latest, VERSION) {
        println!("zv {VERSION} is up to date.");
        return Ok(0);
    }
    if check {
        println!("zv {latest} is available (this is {VERSION}). Run `zv update` to install it.");
        return Ok(0);
    }

    eprintln!("zv: downloading zv {latest}…");
    let base = format!("{RELEASES}/download/v{latest}/{ASSET}");
    let data = fetch(&base)?;
    let sig = fetch(&format!("{base}.sig"))?;
    let sig = String::from_utf8(sig).map_err(|e| UpdateError::BadSignature(e.to_string()))?;
    verify(&data, &sig, pubkey, &latest)?;
    replace(&exe, &data)?;
    println!("Updated zv {VERSION} to {latest}.");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway key pair made for these tests with `tauri signer generate`,
    // and its signature over b"new zv build\n" saved as
    // zv-v1.2.3-macos-universal.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk2QjhCMDY2MkY5QzNGMkMKUldRc1A1d3ZackM0bGd0d0YyNnhmY0RETnJwUGl4TkpwKzltT0JIR0tHQVJRcEEvQU9SSjZ4akUK";
    const TEST_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1A1d3ZackM0bG80NkdpdWZXKzhPc2IycW5VZk94UHpZeFpjbU9FNWNXbG5LdVdMeUJneHEweG91UjE2bW5aVUNoZlVmL0Voci8rVEN6WGFxMjJDQTlIZUhMNjBiR2dNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMzMwOTIzCWZpbGU6enYtdjEuMi4zLW1hY29zLXVuaXZlcnNhbAptQ1ZNaEVLYXEycHVSVTRRL1k2WUZiKzdVVG5Lc3ZNQ0E1ZDdhaUJ2dzJibldKTW16K1JUYmVTNG1JOEY0Ylk1Z0Vra1BEcEJDSk5MRUhkdEFnanNEdz09Cg==";
    const DATA: &[u8] = b"new zv build\n";

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("0.1.1", "0.0.0"));
        assert!(!is_newer("0.1.1", "0.1.1"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert!(!is_newer("garbage", "0.1.0"));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.2.3-beta"), Some((1, 2, 3)));
    }

    #[test]
    fn accepts_a_good_signature() {
        verify(DATA, TEST_SIG, TEST_PUBKEY, "1.2.3").unwrap();
    }

    #[test]
    fn rejects_tampered_data() {
        let err = verify(b"evil zv build\n", TEST_SIG, TEST_PUBKEY, "1.2.3").unwrap_err();
        assert!(matches!(err, UpdateError::BadSignature(_)));
    }

    #[test]
    fn rejects_an_old_build_announced_as_new() {
        let err = verify(DATA, TEST_SIG, TEST_PUBKEY, "9.9.9").unwrap_err();
        assert!(err.to_string().contains("not signed as zv 9.9.9"), "{err}");
    }

    #[test]
    fn bundled_copies_are_left_to_the_app() {
        assert!(inside_app_bundle(Path::new(
            "/Applications/Zvault.app/Contents/MacOS/zv"
        )));
        assert!(!inside_app_bundle(Path::new("/usr/local/bin/zv")));
    }

    #[test]
    fn replaces_the_file_atomically() {
        let dir = std::env::temp_dir().join(format!("zv-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("zv");
        std::fs::write(&exe, b"old").unwrap();
        replace(&exe, DATA).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), DATA);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&exe).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

//! "Install command-line tool": links the `zv` binary that ships inside
//! Zvault.app onto the user's PATH.
//!
//! Release builds bundle `zv` next to the app's own executable (a Tauri
//! sidecar). The link goes in `/usr/local/bin` when that is writable without
//! admin rights, otherwise in `~/.local/bin`.

use std::path::{Path, PathBuf};

use serde::Serialize;

const NAME: &str = "zv";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// Whether this build ships `zv` (release builds do; dev builds do not).
    bundled: bool,
    /// Where `zv` is linked to this app's copy, if anywhere we look.
    installed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstalled {
    path: String,
    /// Whether that directory is on the PATH new terminals get. When not,
    /// the UI should show the line to add to the shell profile.
    on_path: bool,
    path_line: Option<String>,
}

fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let zv = exe.parent()?.join(NAME);
    zv.is_file().then_some(zv)
}

fn candidates() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs
}

fn links_to(link: &Path, target: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|t| t == target)
}

fn writable_dir(dir: &Path) -> bool {
    let probe = dir.join(format!(".zvault-probe-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

/// The PATH a login shell gets, which is what a new terminal sees; the app's
/// own PATH is the minimal one macOS gives GUI apps.
fn login_path() -> Vec<PathBuf> {
    let from_helper = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.split('"')
                .nth(1)
                .map(|p| p.split(':').map(PathBuf::from).collect())
        });
    from_helper.unwrap_or_else(|| {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default()
    })
}

#[tauri::command]
pub fn cli_status() -> CliStatus {
    let target = bundled();
    let installed_at = target.as_ref().and_then(|t| {
        candidates()
            .into_iter()
            .map(|d| d.join(NAME))
            .find(|l| links_to(l, t))
    });
    CliStatus {
        bundled: target.is_some(),
        installed_at: installed_at.map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn cli_install() -> Result<CliInstalled, String> {
    let target = bundled().ok_or("this build of Zvault does not include the zv tool")?;
    install(&target, &candidates(), &login_path())
}

fn install(target: &Path, dirs: &[PathBuf], path: &[PathBuf]) -> Result<CliInstalled, String> {
    for dir in dirs {
        let link = dir.join(NAME);
        if links_to(&link, target) {
            return Ok(done(dir, &link, path));
        }
        if !dir.is_dir() {
            // Only our own fallback directory is created.
            if dir.ends_with(".local/bin") && std::fs::create_dir_all(dir).is_err() {
                continue;
            }
            if !dir.is_dir() {
                continue;
            }
        }
        if !writable_dir(dir) {
            continue;
        }
        match std::fs::symlink_metadata(&link) {
            // Replace an older link to a moved or updated app, but never a
            // real file someone else put there.
            Ok(m) if m.file_type().is_symlink() => {
                std::fs::remove_file(&link).map_err(|e| e.to_string())?;
            }
            Ok(_) => continue,
            Err(_) => {}
        }
        std::os::unix::fs::symlink(target, &link).map_err(|e| e.to_string())?;
        return Ok(done(dir, &link, path));
    }
    Err("could not find a folder to install zv in".into())
}

fn done(dir: &Path, link: &Path, path: &[PathBuf]) -> CliInstalled {
    let on_path = path.iter().any(|p| p == dir);
    CliInstalled {
        path: link.display().to_string(),
        on_path,
        path_line: (!on_path).then(|| format!("export PATH=\"{}:$PATH\"", dir.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_into_the_first_writable_folder_and_keeps_real_files() {
        let root = std::env::temp_dir().join(format!("zvault-cli-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let app = root.join("Zvault.app/Contents/MacOS");
        std::fs::create_dir_all(&app).unwrap();
        let target = app.join(NAME);
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();

        let taken = root.join("taken");
        std::fs::create_dir_all(&taken).unwrap();
        std::fs::write(taken.join(NAME), b"someone else's zv").unwrap();
        let fallback = root.join("home/.local/bin");

        let dirs = vec![root.join("missing"), taken.clone(), fallback.clone()];
        let out = install(&target, &dirs, std::slice::from_ref(&fallback)).unwrap();
        assert_eq!(out.path, fallback.join(NAME).display().to_string());
        assert!(out.on_path);
        assert!(links_to(&fallback.join(NAME), &target));
        assert_eq!(
            std::fs::read(taken.join(NAME)).unwrap(),
            b"someone else's zv"
        );

        // Installing again is a no-op, and says how to fix PATH when needed.
        let again = install(&target, &dirs, &[]).unwrap();
        assert!(!again.on_path);
        assert!(again.path_line.unwrap().contains(".local/bin"));
        let _ = std::fs::remove_dir_all(&root);
    }
}

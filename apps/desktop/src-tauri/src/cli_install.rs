//! "Install command-line tool": links the `zv` binary that ships inside
//! Zvault.app onto the user's PATH.
//!
//! Release builds bundle `zv` next to the app's own executable (a Tauri
//! sidecar). The link goes in `/usr/local/bin` when that is writable without
//! admin rights, otherwise in `~/.local/bin`. With `admin`, macOS asks for an
//! administrator password and the link always goes in `/usr/local/bin`,
//! which every terminal has on its PATH. A second link, `zvault`, points at
//! the same binary for people who look for the app's name.

use std::path::{Path, PathBuf};

use serde::Serialize;

const NAME: &str = "zv";
/// Also linked, so `zvault --help` works too.
const ALIAS: &str = "zvault";
const SYSTEM_DIR: &str = "/usr/local/bin";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// Whether this build ships `zv` (release builds do; dev builds do not).
    bundled: bool,
    /// Where `zv` is linked to this app's copy, if anywhere we look.
    installed_at: Option<String>,
    /// Whether that link's folder is on the PATH new terminals get.
    on_path: bool,
    /// A command that installs this app's `zv`, to paste into a terminal.
    command: Option<String>,
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
    let mut dirs = vec![PathBuf::from(SYSTEM_DIR)];
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
    let path = login_path();
    CliStatus {
        bundled: target.is_some(),
        on_path: installed_at
            .as_ref()
            .and_then(|l| l.parent())
            .is_some_and(|d| path.iter().any(|p| p == d)),
        installed_at: installed_at.map(|p| p.display().to_string()),
        command: target.as_deref().map(terminal_command),
    }
}

#[tauri::command]
pub fn cli_install(admin: Option<bool>) -> Result<CliInstalled, String> {
    let target = bundled().ok_or("this build of Zvault does not include the zv tool")?;
    if admin.unwrap_or(false) {
        install_as_admin(&target)?;
        let dir = PathBuf::from(SYSTEM_DIR);
        return Ok(done(&dir, &dir.join(NAME), &login_path()));
    }
    install(&target, &candidates(), &login_path())
}

/// Quotes `s` for a POSIX shell.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What to paste into a terminal to link `target` into `/usr/local/bin`.
fn terminal_command(target: &Path) -> String {
    let t = sh_quote(&target.display().to_string());
    format!(
        "sudo mkdir -p {SYSTEM_DIR} && sudo ln -sf {t} {SYSTEM_DIR}/{ALIAS} && sudo ln -sf {t} {SYSTEM_DIR}/{NAME}"
    )
}

/// The shell script `install_as_admin` runs as root. Like `install`, it
/// replaces an old link but never a real file someone else put there.
fn admin_script(target: &Path) -> String {
    let link = format!("{SYSTEM_DIR}/{NAME}");
    let alias = format!("{SYSTEM_DIR}/{ALIAS}");
    let t = sh_quote(&target.display().to_string());
    format!(
        "mkdir -p {SYSTEM_DIR} && {{ [ -L {link} ] || [ ! -e {link} ]; }} \
         || {{ echo '{link} is not a link Zvault made; remove it first' >&2; exit 1; }}; \
         ln -sfn {t} {link} && {{ {{ [ -L {alias} ] || [ ! -e {alias} ]; }} && ln -sfn {t} {alias} || true; }}"
    )
}

/// Runs `admin_script` through macOS's administrator password prompt.
fn install_as_admin(target: &Path) -> Result<(), String> {
    let script = admin_script(target)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let out = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{script}\" with administrator privileges"
        ))
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-128") {
        return Err("cancelled".into());
    }
    Err(err
        .trim()
        .rsplit_once("execution error: ")
        .map_or(err.trim(), |(_, e)| e)
        .to_owned())
}

fn install(target: &Path, dirs: &[PathBuf], path: &[PathBuf]) -> Result<CliInstalled, String> {
    for dir in dirs {
        let link = dir.join(NAME);
        if links_to(&link, target) {
            link_alias(target, dir);
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
        link_alias(target, dir);
        return Ok(done(dir, &link, path));
    }
    Err("could not find a folder to install zv in".into())
}

/// Best effort: `zvault` next to `zv`, unless something else has that name.
fn link_alias(target: &Path, dir: &Path) {
    let alias = dir.join(ALIAS);
    match std::fs::symlink_metadata(&alias) {
        Ok(m) if m.file_type().is_symlink() => {
            if links_to(&alias, target) || std::fs::remove_file(&alias).is_err() {
                return;
            }
        }
        Ok(_) => return,
        Err(_) => {}
    }
    let _ = std::os::unix::fs::symlink(target, &alias);
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
        assert!(links_to(&fallback.join(ALIAS), &target));
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

    #[test]
    fn commands_quote_the_app_path() {
        let odd = Path::new("/Users/me/My Apps/Bob's Zvault.app/Contents/MacOS/zv");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "printf %s {}",
                sh_quote(&odd.display().to_string())
            ))
            .output()
            .unwrap();
        assert_eq!(out.stdout, odd.display().to_string().as_bytes());
        assert!(terminal_command(odd).ends_with("/usr/local/bin/zv"));
        assert!(terminal_command(odd).contains("/usr/local/bin/zvault"));
        assert!(admin_script(odd).contains(&sh_quote(&odd.display().to_string())));
    }
}

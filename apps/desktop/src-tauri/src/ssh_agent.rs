//! The SSH agent: a socket `ssh`, `git` and `ssh-add -l` use (through
//! `SSH_AUTH_SOCK` or `IdentityAgent`) to sign with the SSH keys in the vault.
//!
//! For each connection it checks the peer is the same OS user, as the `zv`
//! socket does. Listing keys needs Zvault unlocked (it brings the window
//! forward and waits). Every signature is approved in the app, with Touch ID
//! where Touch ID unlock is set up, and logged in the Agents activity log.
//! The UI only finds the items' ciphertext; the private keys are opened and
//! used here, and never leave Rust. Adding, removing or exporting keys over
//! the socket is not supported.

use std::io::{BufReader, BufWriter};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zvault_agent::protocol::ErrorCode;
use zvault_ssh::agent::{self, Identity, Request, SignPurpose};

use crate::agents::server::{
    Peer, approve_ssh_sign, bind, check_peer, ssh_key_items, wait_unlocked,
};
use crate::vault::{ItemCipher, Keyring};

/// Overrides the socket path, for tests and unusual setups.
const SOCKET_ENV: &str = "ZV_SSH_AGENT_SOCK";
const SETTINGS_FILE: &str = "ssh-agent.json";

/// `~/.zvault/ssh-agent.sock`: short, without spaces, and the same on every
/// Mac, so it can go in `~/.ssh/config` as it is.
pub fn socket_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(SOCKET_ENV) {
        return Some(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join(".zvault").join("ssh-agent.sock"))
}

#[derive(Serialize, Deserialize)]
struct Settings {
    enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Default)]
pub struct SshAgent(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    enabled: bool,
    /// Where it listens, while it does.
    listening: Option<PathBuf>,
    /// Bumped to stop the current listener thread.
    generation: u64,
    error: Option<String>,
}

impl SshAgent {
    fn guard(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn enabled(&self) -> bool {
        self.guard().enabled
    }
}

/// Reads the setting and starts listening if the agent is on. Call from
/// `setup`. Failing to listen leaves the rest of the app working.
pub fn start(app: &AppHandle) {
    let enabled = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read(d.join(SETTINGS_FILE)).ok())
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default()
        .enabled;
    app.state::<SshAgent>().guard().enabled = enabled;
    if enabled {
        listen(app);
    }
}

fn listen(app: &AppHandle) {
    let agent = app.state::<SshAgent>();
    let Some(path) = socket_path() else {
        agent.guard().error = Some("Your home folder could not be found.".into());
        return;
    };
    let listener = match bind(&path) {
        Ok(l) => l,
        Err(e) => {
            agent.guard().error = Some(format!("Could not listen at {}: {e}", path.display()));
            return;
        }
    };
    let generation = {
        let mut inner = agent.guard();
        inner.generation += 1;
        inner.listening = Some(path);
        inner.error = None;
        inner.generation
    };
    let app = app.clone();
    std::thread::Builder::new()
        .name("zvault-ssh-agent".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if app.state::<SshAgent>().guard().generation != generation {
                    break;
                }
                let app = app.clone();
                let _ = std::thread::Builder::new()
                    .name("zvault-ssh-conn".into())
                    .spawn(move || serve(&app, stream));
            }
        })
        .expect("failed to start the SSH agent thread");
}

fn stop(agent: &SshAgent) {
    let path = {
        let mut inner = agent.guard();
        inner.generation += 1;
        inner.listening.take()
    };
    if let Some(path) = path {
        let _ = std::fs::remove_file(&path);
        // Wakes the listener so it sees it should stop. The socket file is
        // already gone, so this reaches nothing when it has stopped.
        let _ = UnixStream::connect(&path);
    }
}

// ---------------------------------------------------------------------------
// Connections

fn serve(app: &AppHandle, stream: UnixStream) {
    let Ok(peer) = check_peer(&stream) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = BufWriter::new(write_half);
    // A client keeps its connection for its whole session and may ask
    // several times; stop at the first malformed message.
    while let Ok(Some(request)) = agent::read_request(&mut reader) {
        let answered = if app.state::<SshAgent>().enabled() {
            match request {
                Request::RequestIdentities => {
                    let ids = identities(app).unwrap_or_default();
                    agent::write_identities(&mut writer, &ids)
                }
                Request::Sign {
                    key_blob,
                    data,
                    flags,
                } => match sign(app, peer, &key_blob, &data, flags) {
                    Ok(signature) => agent::write_signature(&mut writer, &signature),
                    Err(_) => agent::write_failure(&mut writer),
                },
                Request::Unsupported(_) => agent::write_failure(&mut writer),
            }
        } else {
            agent::write_failure(&mut writer)
        };
        if answered.is_err() {
            return;
        }
    }
}

/// A vault item holding an SSH key, with its public half.
struct VaultKey {
    vault_id: String,
    item: ItemCipher,
    title: String,
    public: zvault_ssh::SshPublicKey,
}

fn vault_keys(app: &AppHandle) -> Result<Vec<VaultKey>, ErrorCode> {
    wait_unlocked(app)?;
    let (vault_id, items) = ssh_key_items(app)?;
    let keyring = app.state::<Keyring>();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let (title, key) = keyring.open_item_ssh_key(&vault_id, &item).ok()??;
            let public = key.public().ok()?;
            Some(VaultKey {
                vault_id: vault_id.clone(),
                item,
                title,
                public,
            })
        })
        .collect())
}

fn identities(app: &AppHandle) -> Result<Vec<Identity>, ErrorCode> {
    Ok(vault_keys(app)?
        .into_iter()
        .map(|k| Identity {
            comment: if k.public.comment.is_empty() {
                k.title
            } else {
                k.public.comment
            },
            key_blob: k.public.blob,
        })
        .collect())
}

fn sign(
    app: &AppHandle,
    peer: Peer,
    key_blob: &[u8],
    data: &[u8],
    flags: u32,
) -> Result<Vec<u8>, ErrorCode> {
    let key = vault_keys(app)?
        .into_iter()
        .find(|k| k.public.blob == key_blob)
        .ok_or(ErrorCode::NotFound)?;
    let name = if key.title.is_empty() {
        key.public.comment.clone()
    } else {
        key.title.clone()
    };
    approve_ssh_sign(
        app,
        client_name(peer.pid),
        describe(&agent::sign_purpose(data), &name),
        peer,
    )?;
    let (_, stored) = app
        .state::<Keyring>()
        .open_item_ssh_key(&key.vault_id, &key.item)
        .ok()
        .flatten()
        .ok_or(ErrorCode::NotFound)?;
    stored.sign(data, flags).map_err(|_| ErrorCode::Internal)
}

/// What the approval prompt says is being signed.
fn describe(purpose: &SignPurpose, key: &str) -> String {
    match purpose {
        SignPurpose::Login { user } => {
            format!("Sign in to a server as “{user}” with the SSH key “{key}”.")
        }
        SignPurpose::Signature { namespace } if namespace == "git" => {
            format!("Sign a git commit or tag with the SSH key “{key}”.")
        }
        SignPurpose::Signature { namespace } => {
            format!("Sign data for “{namespace}” with the SSH key “{key}”.")
        }
        SignPurpose::Unknown => format!("Sign with the SSH key “{key}”."),
    }
}

/// Names the client for the prompt: its program, and the program that
/// started it when that is not a shell (`git` runs `ssh`).
fn client_name(pid: Option<i32>) -> String {
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return "An SSH client".into();
    };
    let name = process_name(pid).unwrap_or_else(|| "ssh".into());
    let parent = parent_pid(pid).and_then(process_name);
    match parent {
        Some(p) if p != name && !is_shell(&p) => format!("{p} (via {name})"),
        _ => name,
    }
}

fn is_shell(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash" | "zsh" | "fish" | "dash" | "login" | "launchd" | "tmux" | "screen"
    ) || name.starts_with('-')
}

fn ps_field(pid: i32, field: &str) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn process_name(pid: i32) -> Option<String> {
    let comm = ps_field(pid, "comm")?;
    let base = Path::new(&comm).file_name()?.to_string_lossy().into_owned();
    Some(base.chars().filter(|c| !c.is_control()).take(32).collect())
}

fn parent_pid(pid: i32) -> Option<i32> {
    ps_field(pid, "ppid")?.parse().ok()
}

// ---------------------------------------------------------------------------
// Commands for Settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentStatus {
    enabled: bool,
    listening: bool,
    socket_path: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub fn ssh_agent_status(agent: State<'_, SshAgent>) -> SshAgentStatus {
    let inner = agent.guard();
    SshAgentStatus {
        enabled: inner.enabled,
        listening: inner.listening.is_some(),
        socket_path: inner
            .listening
            .clone()
            .or_else(socket_path)
            .map(|p| p.display().to_string()),
        error: inner.error.clone(),
    }
}

#[tauri::command]
pub fn ssh_agent_set_enabled(
    app: AppHandle,
    agent: State<'_, SshAgent>,
    enabled: bool,
) -> Result<SshAgentStatus, String> {
    if let Ok(dir) = app.path().app_data_dir() {
        let json = serde_json::to_vec(&Settings { enabled }).map_err(|e| e.to_string())?;
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    agent.guard().enabled = enabled;
    let listening = agent.guard().listening.is_some();
    if enabled && !listening {
        listen(&app);
    } else if !enabled {
        stop(&agent);
    }
    Ok(ssh_agent_status(agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_each_kind_of_signature() {
        assert_eq!(
            describe(&SignPurpose::Login { user: "git".into() }, "GitHub"),
            "Sign in to a server as “git” with the SSH key “GitHub”."
        );
        assert_eq!(
            describe(
                &SignPurpose::Signature {
                    namespace: "git".into()
                },
                "GitHub"
            ),
            "Sign a git commit or tag with the SSH key “GitHub”."
        );
        assert_eq!(
            describe(&SignPurpose::Unknown, "k"),
            "Sign with the SSH key “k”."
        );
    }

    #[test]
    fn names_the_client() {
        assert_eq!(client_name(None), "An SSH client");
        // This test process has a parent (cargo), so it gets a name.
        let me = client_name(i32::try_from(std::process::id()).ok());
        assert!(!me.is_empty());
        assert!(is_shell("zsh") && is_shell("-zsh") && !is_shell("git"));
    }

    #[test]
    fn the_socket_path_is_overridable() {
        // Only checks the default shape; the env override is read at runtime.
        if std::env::var_os(SOCKET_ENV).is_none() {
            let p = socket_path().unwrap();
            assert!(p.ends_with(".zvault/ssh-agent.sock"));
        }
    }
}

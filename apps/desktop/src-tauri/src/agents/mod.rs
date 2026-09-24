//! Local access for the `zv` CLI: the socket it talks to, and the commands
//! the Agents screen uses to manage paired agents and answer requests.
//!
//! A request comes from a paired agent (it presents its token) or from the
//! user at a terminal (no token). The app is the only holder of keys. For each
//! request it:
//!
//! 1. checks the peer is the same OS user (`getpeereid` / `SO_PEERCRED`);
//! 2. for an agent, checks its bearer token (stored only as a SHA-256 hash)
//!    and applies its policy: paused, scopes, locked, approval mode;
//! 3. for the user, brings Zvault forward to be unlocked if needed, then asks
//!    for approval unless that terminal ran `zv signin`;
//! 4. shows approvals with [`APPROVAL_EVENT`] and waits for the UI to call
//!    [`agent_approval_respond`], then confirms with Touch ID where the policy
//!    asks for it and Touch ID unlock is set up;
//! 5. asks the UI which secrets the `zv://` paths name ([`RESOLVE_EVENT`],
//!    [`LIST_EVENT`]); the UI sends only ciphertext and Rust decrypts it, so no
//!    secret value passes through JavaScript. `zv set` goes the other way:
//!    Rust seals the value and the UI uploads it ([`WRITE_EVENT`]);
//! 6. logs the use or denial and answers over the socket.
//!
//! Only the values asked for, and allowed, leave the app.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zvault_agent::activity::{ActivityEntry, ActivityLog};
use zvault_agent::policy::{AgentRecord, ApprovalMode, Registry, TerminalGrants};
use zvault_agent::{ScopePattern, SecretRef};

use crate::autolock::AppState;
use crate::vault::Blob;

pub const APPROVAL_EVENT: &str = "agent://approval-request";
pub const PAIRING_EVENT: &str = "agent://pairing-request";
pub const RESOLVE_EVENT: &str = "agent://resolve-request";
pub const LIST_EVENT: &str = "agent://list-request";
pub const WRITE_EVENT: &str = "agent://write-request";
/// `zv` is waiting for the user to unlock Zvault.
pub const UNLOCK_EVENT: &str = "agent://unlock-requested";
/// Sent after every logged entry, and after agent settings change, so open
/// screens can refresh.
pub const ACTIVITY_EVENT: &str = "agent://activity";
/// Sent when a prompt is withdrawn (answered, timed out, or Zvault locked).
pub const PROMPT_CLOSED_EVENT: &str = "agent://prompt-closed";

const REGISTRY_FILE: &str = "agents.json";
const ACTIVITY_FILE: &str = "agent-activity.json";

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The UI's answer to an approval prompt.
enum Answer {
    Approve,
    Deny,
}

struct PairingAnswer {
    approval: ApprovalMode,
    scopes: Vec<ScopePattern>,
}

/// Where the UI found a path. `secret_id` is absent when no secret has
/// that key there yet, and `encrypted_value` when it has no value in that
/// environment; `zv set` then creates them (in `folder_id`, if any).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSecret {
    reference: SecretRef,
    project_id: String,
    environment_id: String,
    #[serde(default)]
    secret_id: Option<String>,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    encrypted_value: Option<Blob>,
    /// The environment `encrypted_value` was sealed for, when the value is
    /// inherited from another environment ("Same as Development").
    #[serde(default)]
    value_environment_id: Option<String>,
}

#[derive(Default)]
struct Inner {
    registry: Registry,
    activity: ActivityLog,
    terminals: TerminalGrants,
    approvals: HashMap<String, mpsc::Sender<Answer>>,
    pairings: HashMap<String, mpsc::Sender<Option<PairingAnswer>>>,
    /// Answers to resolve, list and write requests, as JSON.
    replies: HashMap<String, mpsc::Sender<serde_json::Value>>,
}

impl Inner {
    fn pending_prompts(&self) -> usize {
        self.approvals.len() + self.pairings.len()
    }
}

/// Agent registry, activity log, terminal sign-ins and pending prompts.
#[derive(Default)]
pub struct AgentHub {
    inner: Mutex<Inner>,
    data_dir: Mutex<Option<PathBuf>>,
    socket: Mutex<Option<PathBuf>>,
}

impl AgentHub {
    fn guard(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn save(&self, inner: &Inner) {
        let Some(dir) = self.data_dir() else { return };
        // Failing to persist loses history, not security; the in-memory state
        // stays authoritative for this run.
        let _ = write_private(&dir.join(REGISTRY_FILE), &inner.registry);
        let _ = write_private(&dir.join(ACTIVITY_FILE), &inner.activity);
    }

    /// Locking ends session approvals and terminal sign-ins, and withdraws
    /// open prompts.
    pub fn on_lock(&self) {
        let mut inner = self.guard();
        inner.registry.on_lock();
        inner.terminals.clear();
        for (_, tx) in inner.approvals.drain() {
            let _ = tx.send(Answer::Deny);
        }
        for (_, tx) in inner.pairings.drain() {
            let _ = tx.send(None);
        }
        inner.replies.clear();
    }

    fn log(&self, app: &AppHandle, inner: &mut Inner, entry: ActivityEntry) {
        inner.activity.push(entry.clone());
        self.save(inner);
        let _ = app.emit(ACTIVITY_EVENT, entry);
    }

    /// Passes the UI's answer to whoever is waiting for `request_id`.
    fn reply(&self, request_id: &str, value: serde_json::Value) -> Result<(), String> {
        let tx = self
            .guard()
            .replies
            .remove(request_id)
            .ok_or("this request is no longer waiting")?;
        let _ = tx.send(value);
        Ok(())
    }
}

mod server;

pub use server::start;

// ---------------------------------------------------------------------------
// Commands for the Agents screen

/// An agent as the UI shows it. Leaves out the token hash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    id: String,
    name: String,
    created_at: u64,
    last_used_at: Option<u64>,
    paused: bool,
    approval: ApprovalMode,
    scopes: Vec<ScopePattern>,
}

impl From<&AgentRecord> for AgentView {
    fn from(a: &AgentRecord) -> Self {
        Self {
            id: a.id.clone(),
            name: a.name.clone(),
            created_at: a.created_at,
            last_used_at: a.last_used_at,
            paused: a.paused,
            approval: a.approval,
            scopes: a.scopes.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessStatus {
    listening: bool,
    socket_path: Option<String>,
}

fn parse_scopes(scopes: Vec<String>) -> Result<Vec<ScopePattern>, String> {
    let mut out: Vec<ScopePattern> = scopes
        .iter()
        .map(|s| s.parse().map_err(|e| format!("{s}: {e}")))
        .collect::<Result<_, _>>()?;
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.clone()));
    Ok(out)
}

fn require_unlocked(state: &AppState) -> Result<(), String> {
    if state.session().is_locked() {
        Err("Zvault is locked".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn agent_access_status(hub: State<'_, AgentHub>) -> AgentAccessStatus {
    let socket = hub.socket.lock().unwrap_or_else(|e| e.into_inner()).clone();
    AgentAccessStatus {
        listening: socket.is_some(),
        socket_path: socket.map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn agent_list(hub: State<'_, AgentHub>) -> Vec<AgentView> {
    hub.guard()
        .registry
        .agents()
        .iter()
        .map(AgentView::from)
        .collect()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::too_many_arguments)]
pub fn agent_update(
    app: AppHandle,
    hub: State<'_, AgentHub>,
    state: State<'_, AppState>,
    agent_id: String,
    name: Option<String>,
    paused: Option<bool>,
    approval: Option<ApprovalMode>,
    scopes: Option<Vec<String>>,
) -> Result<AgentView, String> {
    require_unlocked(&state)?;
    let scopes = scopes.map(parse_scopes).transpose()?;
    let mut inner = hub.guard();
    let record = inner
        .registry
        .update(&agent_id, name.as_deref(), paused, approval, scopes)
        .map_err(str::to_owned)?;
    hub.save(&inner);
    drop(inner);
    let _ = app.emit(ACTIVITY_EVENT, ());
    Ok(AgentView::from(&record))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_unpair(
    app: AppHandle,
    hub: State<'_, AgentHub>,
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<(), String> {
    require_unlocked(&state)?;
    server::unpair(&app, &hub, &agent_id)
        .map(|_| ())
        .ok_or_else(|| "no such agent".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_activity(
    hub: State<'_, AgentHub>,
    agent_id: Option<String>,
    limit: Option<u32>,
) -> Vec<ActivityEntry> {
    let limit = limit.unwrap_or(200).min(2000) as usize;
    hub.guard().activity.recent(agent_id.as_deref(), limit)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_approval_respond(
    hub: State<'_, AgentHub>,
    state: State<'_, AppState>,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    let tx = hub
        .guard()
        .approvals
        .remove(&request_id)
        .ok_or("this request is no longer waiting")?;
    let answer = if approve && require_unlocked(&state).is_ok() {
        Answer::Approve
    } else {
        Answer::Deny
    };
    let _ = tx.send(answer);
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_pairing_respond(
    hub: State<'_, AgentHub>,
    state: State<'_, AppState>,
    request_id: String,
    approve: bool,
    approval: Option<ApprovalMode>,
    scopes: Option<Vec<String>>,
) -> Result<(), String> {
    let scopes = scopes.map(parse_scopes).transpose()?.unwrap_or_default();
    let tx = hub
        .guard()
        .pairings
        .remove(&request_id)
        .ok_or("this request is no longer waiting")?;
    let answer = (approve && require_unlocked(&state).is_ok()).then(|| PairingAnswer {
        approval: approval.unwrap_or_default(),
        scopes,
    });
    let _ = tx.send(answer);
    Ok(())
}

/// The UI's answer to [`RESOLVE_EVENT`]: where each reference lives. Leave
/// out references that match nothing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_resolve_respond(
    hub: State<'_, AgentHub>,
    request_id: String,
    items: Vec<ResolvedSecret>,
) -> Result<(), String> {
    let value = serde_json::to_value(items).map_err(|e| e.to_string())?;
    hub.reply(&request_id, value)
}

/// The UI's answer to [`LIST_EVENT`]: the path of every secret under the
/// prefix that has a value in its environment.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_list_respond(
    hub: State<'_, AgentHub>,
    request_id: String,
    refs: Vec<String>,
) -> Result<(), String> {
    hub.reply(&request_id, serde_json::Value::from(refs))
}

/// The UI's answer to [`WRITE_EVENT`]: `error` is `None` once the secret is
/// saved and synced.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_write_respond(
    hub: State<'_, AgentHub>,
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    hub.reply(&request_id, serde_json::Value::from(error))
}

// ---------------------------------------------------------------------------
// Files

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(_) => {
            // Keep a damaged file for inspection rather than overwriting it.
            let _ = std::fs::rename(path, path.with_extension("json.damaged"));
            None
        }
    }
}

/// Writes JSON readable only by this user, replacing the file atomically.
fn write_private<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    let json = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn scopes_from_the_ui_are_validated_and_deduplicated() {
        let s = parse_scopes(vec![
            "zv://web/dev/*".into(),
            "zv://web/dev/*".into(),
            "zv://web/production/DB_PASSWORD".into(),
        ])
        .unwrap();
        assert_eq!(s.len(), 2);
        assert!(parse_scopes(vec!["web/dev".into()]).is_err());
        assert!(parse_scopes(vec!["zv://WEB/dev/*".into()]).is_err());
    }

    #[test]
    fn private_files_are_owner_only() {
        let dir = std::env::temp_dir().join(format!("zvault-agent-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(REGISTRY_FILE);
        write_private(&path, &Registry::default()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let back: Registry = read_json(&path).unwrap();
        assert!(back.agents().is_empty());
        std::fs::write(&path, b"{broken").unwrap();
        assert!(read_json::<Registry>(&path).is_none());
        assert!(path.with_extension("json.damaged").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

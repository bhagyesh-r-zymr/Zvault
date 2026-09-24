//! Local agent access: the socket `zv` talks to, and the commands the Agents
//! screen uses to manage paired agents and answer their requests.
//!
//! The app is the only holder of keys. For each request it:
//!
//! 1. checks the peer is the same OS user (`getpeereid` / `SO_PEERCRED`);
//! 2. checks the agent's bearer token (stored only as a SHA-256 hash);
//! 3. applies the agent's policy: paused, scopes, vault locked, approval mode;
//! 4. when the policy says so, emits [`APPROVAL_EVENT`] and waits for the UI
//!    to call [`agent_approval_respond`], then confirms with Touch ID for
//!    "ask every time" when Touch ID unlock is set up;
//! 5. asks the UI which item each reference names ([`RESOLVE_EVENT`] and
//!    [`agent_resolve_respond`]); the UI sends only ciphertext and Rust
//!    decrypts it, so no secret value passes through JavaScript;
//! 6. logs the use or denial and returns the values over the socket.
//!
//! Only the values asked for, and allowed, leave the app.

use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::os::fd::AsFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;
use zvault_agent::activity::{ActivityEntry, ActivityLog, Outcome, Verification};
use zvault_agent::policy::{AgentRecord, ApprovalMode, Decision, Registry};
use zvault_agent::protocol::{
    self, ErrorCode, MAX_REFS, PROTOCOL_VERSION, Purpose, Request, RequestBody, Response,
    SecretValue,
};
use zvault_agent::{ScopePattern, SecretRef, paths};

use crate::autolock::AppState;
use crate::vault::{ItemCipher, ItemFields, Keyring};

pub const APPROVAL_EVENT: &str = "agent://approval-request";
pub const PAIRING_EVENT: &str = "agent://pairing-request";
pub const RESOLVE_EVENT: &str = "agent://resolve-request";
/// Sent after every logged entry so open screens can refresh.
pub const ACTIVITY_EVENT: &str = "agent://activity";
/// Sent when a prompt is withdrawn (answered elsewhere, timed out, locked).
pub const PROMPT_CLOSED_EVENT: &str = "agent://prompt-closed";

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);
/// A client has this long to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Prompts that may wait at once; more get `Busy`.
const MAX_PENDING_PROMPTS: usize = 4;

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

/// Where the UI found a reference.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    reference: SecretRef,
    vault_id: String,
    item: ItemCipher,
}

#[derive(Default)]
struct Inner {
    registry: Registry,
    activity: ActivityLog,
    approvals: HashMap<String, mpsc::Sender<Answer>>,
    pairings: HashMap<String, mpsc::Sender<Option<PairingAnswer>>>,
    resolves: HashMap<String, mpsc::Sender<Vec<ResolvedItem>>>,
}

impl Inner {
    fn pending_prompts(&self) -> usize {
        self.approvals.len() + self.pairings.len()
    }
}

/// Agent registry, activity log and pending prompts.
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

    /// Locking ends session approvals and withdraws open prompts.
    pub fn on_lock(&self) {
        let mut inner = self.guard();
        inner.registry.on_lock();
        for (_, tx) in inner.approvals.drain() {
            let _ = tx.send(Answer::Deny);
        }
        for (_, tx) in inner.pairings.drain() {
            let _ = tx.send(None);
        }
        inner.resolves.clear();
    }

    fn log(&self, app: &AppHandle, inner: &mut Inner, entry: ActivityEntry) {
        inner.activity.push(entry.clone());
        self.save(inner);
        let _ = app.emit(ACTIVITY_EVENT, entry);
    }
}

// ---------------------------------------------------------------------------
// Socket server

/// Loads saved agents and starts listening. Call from `setup`. Failing to
/// listen leaves the rest of the app working; `zv` will say Zvault is not
/// running.
pub fn start(app: &AppHandle) {
    let hub = app.state::<AgentHub>();
    if let Ok(dir) = app.path().app_data_dir() {
        let mut inner = hub.guard();
        inner.registry = read_json(&dir.join(REGISTRY_FILE)).unwrap_or_default();
        inner.activity = read_json(&dir.join(ACTIVITY_FILE)).unwrap_or_default();
        *hub.data_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    }
    let Some(path) = paths::socket_path() else {
        return;
    };
    let listener = match bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "zvault: agent socket unavailable at {}: {e}",
                path.display()
            );
            return;
        }
    };
    *hub.socket.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    let app = app.clone();
    std::thread::Builder::new()
        .name("zvault-agents".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                let _ = std::thread::Builder::new()
                    .name("zvault-agent-conn".into())
                    .spawn(move || serve(&app, stream));
            }
        })
        .expect("failed to start the agent socket thread");
}

fn bind(path: &Path) -> std::io::Result<UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // The directory may predate us; make sure only we can reach the socket.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    // A socket left by a previous run refuses connections; replace it. A live
    // one means another copy of Zvault is running, so leave it alone.
    if std::fs::symlink_metadata(path).is_ok() {
        if UnixStream::connect(path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another Zvault is already listening",
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// The peer's pid if it runs as our user; `Err` if it does not.
fn check_peer(stream: &UnixStream) -> Result<Option<i32>, ()> {
    let me = nix::unistd::geteuid().as_raw();
    #[cfg(target_os = "linux")]
    {
        let cred = nix::sys::socket::getsockopt(
            &stream.as_fd(),
            nix::sys::socket::sockopt::PeerCredentials,
        )
        .map_err(|_| ())?;
        if cred.uid() != me {
            return Err(());
        }
        Ok(Some(cred.pid()))
    }
    #[cfg(target_os = "macos")]
    {
        let (uid, _) = nix::unistd::getpeereid(stream.as_fd()).map_err(|_| ())?;
        if uid.as_raw() != me {
            return Err(());
        }
        Ok(
            nix::sys::socket::getsockopt(&stream.as_fd(), nix::sys::socket::sockopt::LocalPeerPid)
                .ok(),
        )
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (stream, me);
        Err(())
    }
}

fn serve(app: &AppHandle, stream: UnixStream) {
    let Ok(peer_pid) = check_peer(&stream) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let response = match protocol::read_message::<Request>(&mut BufReader::new(stream)) {
        Ok(req) if req.v != PROTOCOL_VERSION => Response::error(ErrorCode::UnsupportedVersion),
        Ok(req) => handle(app, req, peer_pid),
        Err(_) => Response::error(ErrorCode::BadRequest),
    };
    let _ = protocol::write_message(&mut writer, &response);
    let _ = writer.flush();
}

fn handle(app: &AppHandle, req: Request, peer_pid: Option<i32>) -> Response {
    let hub = app.state::<AgentHub>();
    let result = match req.body {
        RequestBody::Pair { name, code } => pair(app, &hub, &name, &code, peer_pid),
        body => {
            let Some(auth) = req.auth else {
                return Response::error(ErrorCode::Unauthorized);
            };
            let agent = hub
                .guard()
                .registry
                .authenticate(&auth.agent_id, &auth.token)
                .cloned();
            let Some(agent) = agent else {
                return Response::error(ErrorCode::Unauthorized);
            };
            match body {
                RequestBody::Status => Ok(Response::Status(agent.status())),
                RequestBody::Unpair => {
                    unpair(app, &hub, &agent.id);
                    Ok(Response::Ok)
                }
                RequestBody::Fetch { refs, purpose } => {
                    fetch(app, &hub, &agent, refs, purpose, peer_pid)
                }
                RequestBody::Pair { .. } => unreachable!(),
            }
        }
    };
    result.unwrap_or_else(Response::error)
}

fn pair(
    app: &AppHandle,
    hub: &AgentHub,
    name: &str,
    code: &str,
    peer_pid: Option<i32>,
) -> Result<Response, ErrorCode> {
    let name = zvault_agent::policy::clean_name(name).ok_or(ErrorCode::BadRequest)?;
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ErrorCode::BadRequest);
    }
    // Pairing needs someone at the unlocked app to approve it.
    if app.state::<AppState>().session().is_locked() {
        return Err(ErrorCode::Locked);
    }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    {
        let mut inner = hub.guard();
        if inner.pending_prompts() >= MAX_PENDING_PROMPTS {
            return Err(ErrorCode::Busy);
        }
        inner.pairings.insert(request_id.clone(), tx);
    }
    let _ = app.emit(
        PAIRING_EVENT,
        PairingPrompt {
            request_id: &request_id,
            name: &name,
            code,
            peer_pid,
            expires_in_secs: PAIRING_TIMEOUT.as_secs(),
        },
    );
    let answer = rx.recv_timeout(PAIRING_TIMEOUT);
    close_prompt(app, hub, &request_id);
    let answer = match answer {
        Ok(Some(a)) => a,
        Ok(None) => return Err(ErrorCode::Denied),
        Err(_) => return Err(ErrorCode::Timeout),
    };

    let mut inner = hub.guard();
    let (record, token) = inner
        .registry
        .pair(&name, answer.approval, answer.scopes, now_secs())
        .map_err(|_| ErrorCode::BadRequest)?;
    let entry = entry(&record, Outcome::Paired, vec![], None, None, None, peer_pid);
    hub.log(app, &mut inner, entry);
    Ok(Response::Paired {
        agent_id: record.id,
        name: record.name,
        token,
    })
}

fn unpair(app: &AppHandle, hub: &AgentHub, agent_id: &str) -> Option<AgentRecord> {
    let mut inner = hub.guard();
    let record = inner.registry.unpair(agent_id)?;
    let entry = entry(&record, Outcome::Unpaired, vec![], None, None, None, None);
    hub.log(app, &mut inner, entry);
    Some(record)
}

fn fetch(
    app: &AppHandle,
    hub: &AgentHub,
    agent: &AgentRecord,
    mut refs: Vec<SecretRef>,
    purpose: Purpose,
    peer_pid: Option<i32>,
) -> Result<Response, ErrorCode> {
    refs.sort();
    refs.dedup();
    if refs.len() > MAX_REFS {
        return Err(ErrorCode::BadRequest);
    }
    let deny = |code: ErrorCode| {
        let mut inner = hub.guard();
        let e = entry(
            agent,
            Outcome::Denied,
            refs.clone(),
            Some(purpose.clone()),
            Some(code),
            None,
            peer_pid,
        );
        hub.log(app, &mut inner, e);
        code
    };

    let unlocked = !app.state::<AppState>().session().is_locked();
    let decision = hub
        .guard()
        .registry
        .decide(&agent.id, &refs, unlocked, now_secs());
    let verified_by = match decision {
        Decision::Deny(code) => return Err(deny(code)),
        Decision::Allow => None,
        Decision::Ask { touch_id } => {
            match ask(app, hub, agent, &refs, &purpose, peer_pid, touch_id) {
                Ok(v) => Some(v),
                Err(code) => return Err(deny(code)),
            }
        }
    };

    let values = match resolve(app, hub, &refs) {
        Ok(v) => v,
        Err(code) => return Err(deny(code)),
    };

    let mut inner = hub.guard();
    if verified_by.is_some() {
        inner.registry.approved(&agent.id, &refs, now_secs());
    }
    inner.registry.touch(&agent.id, now_secs());
    let outcome = if verified_by.is_some() {
        Outcome::Approved
    } else {
        Outcome::Allowed
    };
    let e = entry(
        agent,
        outcome,
        refs,
        Some(purpose),
        None,
        verified_by,
        peer_pid,
    );
    hub.log(app, &mut inner, e);
    Ok(Response::Secrets { values })
}

/// Shows the approval prompt and waits for the answer.
fn ask(
    app: &AppHandle,
    hub: &AgentHub,
    agent: &AgentRecord,
    refs: &[SecretRef],
    purpose: &Purpose,
    peer_pid: Option<i32>,
    touch_id: bool,
) -> Result<Verification, ErrorCode> {
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    {
        let mut inner = hub.guard();
        if inner.pending_prompts() >= MAX_PENDING_PROMPTS {
            return Err(ErrorCode::Busy);
        }
        inner.approvals.insert(request_id.clone(), tx);
    }
    let touch_id_ready = touch_id && crate::commands::touch_id_account(app).is_some();
    let _ = app.emit(
        APPROVAL_EVENT,
        ApprovalPrompt {
            request_id: &request_id,
            agent_id: &agent.id,
            agent_name: &agent.name,
            refs,
            purpose,
            peer_pid,
            approval: agent.approval,
            touch_id: touch_id_ready,
            expires_in_secs: APPROVAL_TIMEOUT.as_secs(),
        },
    );
    let answer = rx.recv_timeout(APPROVAL_TIMEOUT);
    close_prompt(app, hub, &request_id);
    match answer {
        Ok(Answer::Approve) => {}
        Ok(Answer::Deny) => return Err(ErrorCode::Denied),
        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
            return Err(ErrorCode::Timeout);
        }
    }
    if !touch_id_ready {
        return Ok(Verification::Click);
    }
    // Reading the Touch ID Keychain item shows the system Touch ID sheet and
    // succeeds only for an enrolled finger. We discard what it returns.
    let account = crate::commands::touch_id_account(app).ok_or(ErrorCode::Denied)?;
    match crate::biometric::load(&account) {
        Ok(_record) => Ok(Verification::TouchId),
        Err(_) => Err(ErrorCode::Denied),
    }
}

fn close_prompt(app: &AppHandle, hub: &AgentHub, request_id: &str) {
    let mut inner = hub.guard();
    inner.approvals.remove(request_id);
    inner.pairings.remove(request_id);
    drop(inner);
    let _ = app.emit(PROMPT_CLOSED_EVENT, request_id);
}

/// Asks the UI where each reference lives, then decrypts in Rust.
fn resolve(
    app: &AppHandle,
    hub: &AgentHub,
    refs: &[SecretRef],
) -> Result<Vec<SecretValue>, ErrorCode> {
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    hub.guard().resolves.insert(request_id.clone(), tx);
    let _ = app.emit(
        RESOLVE_EVENT,
        ResolvePrompt {
            request_id: &request_id,
            refs,
        },
    );
    let found = rx.recv_timeout(RESOLVE_TIMEOUT);
    hub.guard().resolves.remove(&request_id);
    let found = found.map_err(|_| ErrorCode::Internal)?;

    let keyring = app.state::<Keyring>();
    refs.iter()
        .map(|r| {
            let item = found
                .iter()
                .find(|f| &f.reference == r)
                .ok_or(ErrorCode::NotFound)?;
            let fields = keyring
                .open_item(&item.vault_id, &item.item)
                .map_err(|e| match e {
                    crate::vault::VaultError::Locked => ErrorCode::Locked,
                    _ => ErrorCode::NotFound,
                })?;
            let value = field(&fields, r.field_or_default()).ok_or(ErrorCode::NotFound)?;
            Ok(SecretValue {
                reference: r.clone(),
                value,
            })
        })
        .collect()
}

/// Picks a field out of an item. Field names match the item editor.
fn field(fields: &ItemFields, name: &str) -> Option<Zeroizing<String>> {
    let value = match name {
        "password" => &fields.password,
        "username" => &fields.username,
        "notes" => &fields.notes,
        "title" => &fields.title,
        "url" => fields.urls.first()?,
        _ => return None,
    };
    Some(Zeroizing::new(value.clone()))
}

fn entry(
    agent: &AgentRecord,
    outcome: Outcome,
    refs: Vec<SecretRef>,
    purpose: Option<Purpose>,
    reason: Option<ErrorCode>,
    verified_by: Option<Verification>,
    peer_pid: Option<i32>,
) -> ActivityEntry {
    ActivityEntry {
        at: now_secs(),
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        outcome,
        refs,
        purpose,
        reason,
        verified_by,
        peer_pid,
    }
}

// ---------------------------------------------------------------------------
// Events for the UI

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingPrompt<'a> {
    request_id: &'a str,
    name: &'a str,
    /// Shown in the terminal too, so the user knows which `zv` is asking.
    code: &'a str,
    peer_pid: Option<i32>,
    expires_in_secs: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalPrompt<'a> {
    request_id: &'a str,
    agent_id: &'a str,
    agent_name: &'a str,
    refs: &'a [SecretRef],
    /// Reported by `zv`, so show it as the agent's claim.
    purpose: &'a Purpose,
    peer_pid: Option<i32>,
    approval: ApprovalMode,
    /// Approving will also show the system Touch ID sheet.
    touch_id: bool,
    expires_in_secs: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvePrompt<'a> {
    request_id: &'a str,
    refs: &'a [SecretRef],
}

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
    unpair(&app, &hub, &agent_id)
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

/// The UI's answer to [`RESOLVE_EVENT`]: the encrypted item for each
/// reference it found. References it could not find are left out.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn agent_resolve_respond(
    hub: State<'_, AgentHub>,
    request_id: String,
    items: Vec<ResolvedItem>,
) -> Result<(), String> {
    let tx = hub
        .guard()
        .resolves
        .remove(&request_id)
        .ok_or("this request is no longer waiting")?;
    let _ = tx.send(items);
    Ok(())
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
    use super::*;

    #[test]
    fn picks_named_fields_only() {
        let fields = ItemFields {
            title: "Stripe".into(),
            username: "ops".into(),
            password: "sk_live_x".into(),
            urls: vec!["https://stripe.com".into()],
            notes: "n".into(),
            totp: String::new(),
        };
        assert_eq!(field(&fields, "password").unwrap().as_str(), "sk_live_x");
        assert_eq!(field(&fields, "username").unwrap().as_str(), "ops");
        assert_eq!(
            field(&fields, "url").unwrap().as_str(),
            "https://stripe.com"
        );
        assert!(field(&fields, "secret").is_none());
        assert!(field(&ItemFields::default(), "url").is_none());
    }

    #[test]
    fn scopes_from_the_ui_are_validated_and_deduplicated() {
        let s = parse_scopes(vec![
            "zv://web/dev/*".into(),
            "zv://WEB/dev/*".into(),
            "zv://web/prod/db#password".into(),
        ])
        .unwrap();
        assert_eq!(s.len(), 2);
        assert!(parse_scopes(vec!["web/dev".into()]).is_err());
    }

    #[test]
    fn the_socket_is_private_and_answers_the_same_user() {
        let dir = std::env::temp_dir().join(format!("zvault-agent-sock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("agent.sock");
        let listener = bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);

        let _client = UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        let pid = check_peer(&server).unwrap();
        assert_eq!(pid, Some(i32::try_from(std::process::id()).unwrap()));

        // A second bind while the first is live must not steal the socket.
        // (Its probe connection is left in the backlog, so this comes after
        // the accept above.)
        assert!(bind(&path).is_err());

        drop(listener);
        // A stale socket file is replaced.
        assert!(bind(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
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

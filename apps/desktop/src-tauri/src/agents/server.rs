//! The socket `zv` connects to, and how each request is decided.

use std::io::{BufReader, Write};
use std::os::fd::AsFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use zvault_agent::activity::{ActivityEntry, Outcome, Verification};
use zvault_agent::policy::{AgentRecord, ApprovalMode, Decision};
use zvault_agent::protocol::{
    self, ErrorCode, MAX_REFS, PROTOCOL_VERSION, Purpose, PurposeKind, Request, RequestBody,
    Response, SecretValue,
};
use zvault_agent::{ScopePattern, SecretRef, paths};

use super::{
    ACTIVITY_FILE, APPROVAL_EVENT, AgentHub, Answer, LIST_EVENT, PAIRING_EVENT,
    PROMPT_CLOSED_EVENT, REGISTRY_FILE, RESOLVE_EVENT, ResolvedSecret, UNLOCK_EVENT, WRITE_EVENT,
    now_secs, read_json,
};
use crate::autolock::AppState;
use crate::projects::EntryKind;
use crate::vault::{Blob, Keyring, VaultError};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const UNLOCK_TIMEOUT: Duration = Duration::from_secs(120);
/// For the UI to look up items.
const UI_TIMEOUT: Duration = Duration::from_secs(15);
/// For the UI to save and sync an item.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// A client has this long to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Prompts that may wait at once; more get `Busy`.
const MAX_PENDING_PROMPTS: usize = 4;

/// How the user appears in prompts and the activity log.
const USER_ID: &str = "user";
const USER_NAME: &str = "You (terminal)";

/// The process on the other end of the socket, as the OS reports it.
#[derive(Debug, Clone, Copy, Default)]
struct Peer {
    pid: Option<i32>,
    /// Its session id: shared by a terminal's shell and everything it starts.
    sid: Option<i32>,
}

enum Who {
    Agent(AgentRecord),
    User,
}

impl Who {
    fn id(&self) -> &str {
        match self {
            Self::Agent(a) => &a.id,
            Self::User => USER_ID,
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Agent(a) => &a.name,
            Self::User => USER_NAME,
        }
    }
}

// ---------------------------------------------------------------------------
// Listening

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

/// The peer, if it runs as our user; `Err` if it does not.
fn check_peer(stream: &UnixStream) -> Result<Peer, ()> {
    let me = nix::unistd::geteuid().as_raw();
    #[cfg(target_os = "linux")]
    let pid = {
        let cred = nix::sys::socket::getsockopt(
            &stream.as_fd(),
            nix::sys::socket::sockopt::PeerCredentials,
        )
        .map_err(|_| ())?;
        if cred.uid() != me {
            return Err(());
        }
        Some(cred.pid())
    };
    #[cfg(target_os = "macos")]
    let pid = {
        let (uid, _) = nix::unistd::getpeereid(stream.as_fd()).map_err(|_| ())?;
        if uid.as_raw() != me {
            return Err(());
        }
        nix::sys::socket::getsockopt(&stream.as_fd(), nix::sys::socket::sockopt::LocalPeerPid).ok()
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let pid: Option<i32> = {
        let _ = (stream, me);
        return Err(());
    };
    let sid = pid
        .filter(|p| *p > 0)
        .and_then(|p| nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(p))).ok())
        .map(nix::unistd::Pid::as_raw);
    Ok(Peer { pid, sid })
}

fn serve(app: &AppHandle, stream: UnixStream) {
    let Ok(peer) = check_peer(&stream) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let response = match protocol::read_message::<Request>(&mut BufReader::new(stream)) {
        Ok(req) if req.v != PROTOCOL_VERSION => Response::error(ErrorCode::UnsupportedVersion),
        Ok(req) => handle(app, req, peer),
        Err(_) => Response::error(ErrorCode::BadRequest),
    };
    let _ = protocol::write_message(&mut writer, &response);
    let _ = writer.flush();
}

// ---------------------------------------------------------------------------
// Requests

fn handle(app: &AppHandle, req: Request, peer: Peer) -> Response {
    let hub = app.state::<AgentHub>();
    let who = match &req.auth {
        None => Who::User,
        Some(auth) => {
            let agent = hub
                .guard()
                .registry
                .authenticate(&auth.agent_id, &auth.token)
                .cloned();
            match agent {
                Some(a) => Who::Agent(a),
                None => return Response::error(ErrorCode::Unauthorized),
            }
        }
    };
    let hub = &*hub;
    let result = match (req.body, &who) {
        (RequestBody::AppStatus, _) => Ok(app_status(app, hub, peer)),
        (RequestBody::Unlock, _) => wait_unlocked(app).map(|()| Response::Ok),
        (RequestBody::Fetch { refs, purpose }, _) => fetch(app, hub, &who, refs, &purpose, peer),
        (RequestBody::List { prefix }, _) => list(app, hub, &who, prefix.as_ref(), peer),
        (RequestBody::Export { prefix, purpose }, _) => {
            export(app, hub, &who, &prefix, &purpose, peer)
        }

        (RequestBody::Status, Who::Agent(a)) => Ok(Response::Status(a.status())),
        (RequestBody::Unpair, Who::Agent(a)) => {
            unpair(app, hub, &a.id);
            Ok(Response::Ok)
        }
        (RequestBody::Status | RequestBody::Unpair, Who::User) => Err(ErrorCode::AgentsOnly),

        (RequestBody::Pair { name, code }, Who::User) => pair(app, hub, &name, &code, peer),
        (RequestBody::SignIn, Who::User) => sign_in(app, hub, peer),
        (RequestBody::SignOut, Who::User) => {
            if let Some(sid) = peer.sid {
                hub.guard().terminals.revoke(sid);
            }
            Ok(Response::Ok)
        }
        (RequestBody::Copy { reference }, Who::User) => copy(app, hub, reference, peer),
        (RequestBody::Set { reference, value }, Who::User) => {
            set(app, hub, reference, &value, peer)
        }
        (
            RequestBody::Pair { .. }
            | RequestBody::SignIn
            | RequestBody::SignOut
            | RequestBody::Copy { .. }
            | RequestBody::Set { .. },
            Who::Agent(_),
        ) => Err(ErrorCode::UserOnly),
    };
    result.unwrap_or_else(Response::error)
}

fn app_status(app: &AppHandle, hub: &AgentHub, peer: Peer) -> Response {
    let locked = app.state::<AppState>().session().is_locked();
    let remaining = peer
        .sid
        .and_then(|sid| hub.guard().terminals.remaining(sid, now_secs()));
    Response::AppStatus {
        locked,
        signed_in: !locked && remaining.is_some(),
        signed_in_secs: remaining.filter(|_| !locked),
    }
}

/// Brings Zvault forward and waits for the user to unlock it.
fn wait_unlocked(app: &AppHandle) -> Result<(), ErrorCode> {
    let locked = || app.state::<AppState>().session().is_locked();
    if !locked() {
        return Ok(());
    }
    let _ = app.emit(UNLOCK_EVENT, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let deadline = Instant::now() + UNLOCK_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if !locked() {
            return Ok(());
        }
    }
    Err(ErrorCode::Locked)
}

fn pair(
    app: &AppHandle,
    hub: &AgentHub,
    name: &str,
    code: &str,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    let name = zvault_agent::policy::clean_name(name).ok_or(ErrorCode::BadRequest)?;
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ErrorCode::BadRequest);
    }
    wait_unlocked(app)?;
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
            peer_pid: peer.pid,
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
    let who = Who::Agent(record.clone());
    let entry = entry(&who, Outcome::Paired, vec![], None, None, None, peer);
    hub.log(app, &mut inner, entry);
    Ok(Response::Paired {
        agent_id: record.id,
        name: record.name,
        token,
    })
}

pub(super) fn unpair(app: &AppHandle, hub: &AgentHub, agent_id: &str) -> Option<AgentRecord> {
    let mut inner = hub.guard();
    let record = inner.registry.unpair(agent_id)?;
    let who = Who::Agent(record.clone());
    let entry = entry(
        &who,
        Outcome::Unpaired,
        vec![],
        None,
        None,
        None,
        Peer::default(),
    );
    hub.log(app, &mut inner, entry);
    Some(record)
}

fn sign_in(app: &AppHandle, hub: &AgentHub, peer: Peer) -> Result<Response, ErrorCode> {
    // Without a session id there is no terminal to remember.
    let sid = peer.sid.ok_or(ErrorCode::BadRequest)?;
    let purpose = Purpose {
        kind: PurposeKind::SignIn,
        command: vec![],
        cwd: None,
    };
    logged(app, hub, &Who::User, &[], &purpose, peer, || {
        hub.guard().terminals.grant(sid, now_secs());
        Ok(())
    })?;
    Ok(Response::Ok)
}

fn fetch(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    mut refs: Vec<SecretRef>,
    purpose: &Purpose,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    refs.sort();
    refs.dedup();
    if refs.is_empty() || refs.len() > MAX_REFS {
        return Err(ErrorCode::BadRequest);
    }
    let values = logged(app, hub, who, &refs, purpose, peer, || {
        let found = resolve(app, hub, &refs)?;
        decrypt(app, &refs, &found)
    })?;
    Ok(Response::Secrets { values })
}

fn list(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    prefix: Option<&ScopePattern>,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    let purpose = Purpose {
        kind: PurposeKind::List,
        command: vec![],
        cwd: None,
    };
    let refs = match who {
        // Names inside an agent's scopes are already approved for it, so
        // listing them needs no prompt.
        Who::Agent(a) => {
            if a.paused {
                return Err(ErrorCode::Paused);
            }
            if app.state::<AppState>().session().is_locked() {
                return Err(ErrorCode::Locked);
            }
            let mut refs = list_refs(app, hub, prefix)?;
            refs.retain(|r| a.scopes.iter().any(|s| s.allows(r)));
            refs
        }
        Who::User => logged(app, hub, who, &[], &purpose, peer, || {
            list_refs(app, hub, prefix)
        })?,
    };
    Ok(Response::List { refs })
}

fn export(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    prefix: &ScopePattern,
    purpose: &Purpose,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    match who {
        Who::Agent(a) if a.paused => return Err(ErrorCode::Paused),
        Who::Agent(_) if app.state::<AppState>().session().is_locked() => {
            return Err(ErrorCode::Locked);
        }
        Who::Agent(_) => {}
        Who::User => wait_unlocked(app)?,
    }
    let mut refs = list_refs(app, hub, Some(prefix))?;
    if let Who::Agent(a) = who {
        let total = refs.len();
        refs.retain(|r| a.scopes.iter().any(|s| s.allows(r)));
        if refs.is_empty() && total > 0 {
            return Err(ErrorCode::OutOfScope);
        }
    }
    if refs.is_empty() {
        return Ok(Response::Secrets { values: vec![] });
    }
    fetch(app, hub, who, refs, purpose, peer)
}

fn copy(
    app: &AppHandle,
    hub: &AgentHub,
    reference: SecretRef,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    let purpose = Purpose {
        kind: PurposeKind::Copy,
        command: vec![],
        cwd: None,
    };
    let refs = [reference];
    let secs = logged(app, hub, &Who::User, &refs, &purpose, peer, || {
        let found = resolve(app, hub, &refs)?;
        let values = decrypt(app, &refs, &found)?;
        let state = app.state::<AppState>();
        let settings = state.session().settings();
        state
            .clipboard
            .copy_secret(&values[0].value, settings.clipboard_clear_after())
            .map_err(|_| ErrorCode::Internal)?;
        Ok(settings.clipboard_clear_secs)
    })?;
    Ok(Response::Copied {
        clear_after_secs: secs,
    })
}

fn set(
    app: &AppHandle,
    hub: &AgentHub,
    reference: SecretRef,
    value: &str,
    peer: Peer,
) -> Result<Response, ErrorCode> {
    let purpose = Purpose {
        kind: PurposeKind::Set,
        command: vec![],
        cwd: None,
    };
    let refs = [reference];
    logged(app, hub, &Who::User, &refs, &purpose, peer, || {
        let r = &refs[0];
        let place = resolve(app, hub, &refs)?
            .into_iter()
            .find(|f| &f.reference == r)
            .ok_or(ErrorCode::NotFound)?;
        let keyring = app.state::<Keyring>();
        // A new secret gets its metadata sealed here too, so the UI never
        // handles anything but ciphertext.
        let (secret_id, encrypted_meta) = match &place.secret_id {
            Some(id) => (id.clone(), None),
            None => {
                let meta = serde_json::json!({
                    "name": r.key,
                    "key": r.key,
                    "folderId": place.folder_id,
                    "tags": [],
                });
                let sealed = keyring
                    .seal_entry(&place.project_id, EntryKind::Secret, None, &meta)
                    .map_err(vault_error)?;
                (sealed.id, Some(sealed.encrypted_meta))
            }
        };
        let encrypted_value = keyring
            .seal_secret_value(
                &place.project_id,
                &secret_id,
                &place.environment_id,
                value.to_owned(),
            )
            .map_err(vault_error)?;
        let created = encrypted_meta.is_some();
        let error: Option<String> =
            ui_request(app, hub, WRITE_EVENT, WRITE_TIMEOUT, |request_id| {
                WritePrompt {
                    request_id,
                    reference: r.clone(),
                    project_id: place.project_id.clone(),
                    environment_id: place.environment_id.clone(),
                    secret_id,
                    encrypted_value,
                    encrypted_meta,
                    created,
                }
            })?;
        match error {
            None => Ok(()),
            Some(_) => Err(ErrorCode::Internal),
        }
    })?;
    Ok(Response::Ok)
}

// ---------------------------------------------------------------------------
// Deciding

/// Decides whether `who` may do this, asking the user when needed. Returns
/// how the user approved, or `None` when no prompt was needed.
fn authorize(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    refs: &[SecretRef],
    purpose: &Purpose,
    peer: Peer,
) -> Result<Option<Verification>, ErrorCode> {
    match who {
        Who::Agent(a) => {
            let unlocked = !app.state::<AppState>().session().is_locked();
            let decision = hub
                .guard()
                .registry
                .decide(&a.id, refs, unlocked, now_secs());
            match decision {
                Decision::Deny(code) => Err(code),
                Decision::Allow => Ok(None),
                Decision::Ask { touch_id } => {
                    ask(app, hub, who, refs, purpose, peer, touch_id).map(Some)
                }
            }
        }
        Who::User => {
            wait_unlocked(app)?;
            // Changes and new sign-ins always need the user.
            let may_skip = !matches!(purpose.kind, PurposeKind::Set | PurposeKind::SignIn);
            if may_skip
                && peer
                    .sid
                    .is_some_and(|sid| hub.guard().terminals.use_grant(sid, now_secs()))
            {
                return Ok(None);
            }
            ask(app, hub, who, refs, purpose, peer, true).map(Some)
        }
    }
}

/// Authorizes, does `work`, and logs the outcome either way.
fn logged<T>(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    refs: &[SecretRef],
    purpose: &Purpose,
    peer: Peer,
    work: impl FnOnce() -> Result<T, ErrorCode>,
) -> Result<T, ErrorCode> {
    let result = authorize(app, hub, who, refs, purpose, peer)
        .and_then(|verified| work().map(|t| (t, verified)));
    let now = now_secs();
    let mut inner = hub.guard();
    let e = match &result {
        Ok((_, verified)) => {
            if let Who::Agent(a) = who {
                if verified.is_some() {
                    inner.registry.approved(&a.id, refs, now);
                }
                inner.registry.touch(&a.id, now);
            }
            let outcome = if verified.is_some() {
                Outcome::Approved
            } else {
                Outcome::Allowed
            };
            entry(
                who,
                outcome,
                refs.to_vec(),
                Some(purpose.clone()),
                None,
                *verified,
                peer,
            )
        }
        Err(code) => entry(
            who,
            Outcome::Denied,
            refs.to_vec(),
            Some(purpose.clone()),
            Some(*code),
            None,
            peer,
        ),
    };
    hub.log(app, &mut inner, e);
    result.map(|(t, _)| t)
}

/// Shows the approval prompt and waits for the answer.
fn ask(
    app: &AppHandle,
    hub: &AgentHub,
    who: &Who,
    refs: &[SecretRef],
    purpose: &Purpose,
    peer: Peer,
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
    let (principal, agent_id, approval) = match who {
        Who::Agent(a) => ("agent", Some(a.id.as_str()), Some(a.approval)),
        Who::User => ("user", None, None),
    };
    let _ = app.emit(
        APPROVAL_EVENT,
        ApprovalPrompt {
            request_id: &request_id,
            principal,
            agent_id,
            agent_name: who.name(),
            refs,
            purpose,
            peer_pid: peer.pid,
            approval,
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

// ---------------------------------------------------------------------------
// Talking to the UI

/// Emits `event` with a fresh request id and waits for the UI's reply.
fn ui_request<T: DeserializeOwned, P: Serialize + Clone>(
    app: &AppHandle,
    hub: &AgentHub,
    event: &str,
    timeout: Duration,
    payload: impl FnOnce(String) -> P,
) -> Result<T, ErrorCode> {
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    hub.guard().replies.insert(request_id.clone(), tx);
    let _ = app.emit(event, payload(request_id.clone()));
    let reply = rx.recv_timeout(timeout);
    hub.guard().replies.remove(&request_id);
    let reply = reply.map_err(|_| ErrorCode::Internal)?;
    serde_json::from_value(reply).map_err(|_| ErrorCode::Internal)
}

/// Asks the UI where each path lives.
fn resolve(
    app: &AppHandle,
    hub: &AgentHub,
    refs: &[SecretRef],
) -> Result<Vec<ResolvedSecret>, ErrorCode> {
    ui_request(app, hub, RESOLVE_EVENT, UI_TIMEOUT, |id| RefsPrompt {
        request_id: id,
        refs,
    })
}

/// Asks the UI for the items under `prefix`. The UI's answer is filtered
/// again here, so a mistake there cannot widen what is returned.
fn list_refs(
    app: &AppHandle,
    hub: &AgentHub,
    prefix: Option<&ScopePattern>,
) -> Result<Vec<SecretRef>, ErrorCode> {
    let prefix_text = prefix.map(ToString::to_string);
    let raw: Vec<String> = ui_request(app, hub, LIST_EVENT, UI_TIMEOUT, |id| ListPrompt {
        request_id: id,
        prefix: prefix_text.as_deref(),
    })?;
    let mut refs: Vec<SecretRef> = raw
        .iter()
        .filter_map(|s| s.parse::<SecretRef>().ok())
        .filter(|r| prefix.is_none_or(|p| p.allows(r)))
        .collect();
    refs.sort();
    refs.dedup();
    Ok(refs)
}

/// Decrypts each path's value from what the UI found.
fn decrypt(
    app: &AppHandle,
    refs: &[SecretRef],
    found: &[ResolvedSecret],
) -> Result<Vec<SecretValue>, ErrorCode> {
    let keyring = app.state::<Keyring>();
    refs.iter()
        .map(|r| {
            let place = found
                .iter()
                .find(|f| &f.reference == r)
                .ok_or(ErrorCode::NotFound)?;
            let (Some(secret_id), Some(blob)) = (&place.secret_id, &place.encrypted_value) else {
                return Err(ErrorCode::NotFound);
            };
            let value = keyring
                .open_secret_value(
                    &place.project_id,
                    secret_id,
                    place
                        .value_environment_id
                        .as_deref()
                        .unwrap_or(&place.environment_id),
                    blob,
                )
                .map_err(vault_error)?;
            Ok(SecretValue {
                reference: r.clone(),
                value,
            })
        })
        .collect()
}

fn vault_error(e: VaultError) -> ErrorCode {
    match e {
        VaultError::Locked => ErrorCode::Locked,
        VaultError::VaultNotOpen | VaultError::Decrypt | VaultError::InvalidRecord => {
            ErrorCode::NotFound
        }
        VaultError::Encrypt => ErrorCode::Internal,
    }
}

fn entry(
    who: &Who,
    outcome: Outcome,
    refs: Vec<SecretRef>,
    purpose: Option<Purpose>,
    reason: Option<ErrorCode>,
    verified_by: Option<Verification>,
    peer: Peer,
) -> ActivityEntry {
    ActivityEntry {
        at: now_secs(),
        agent_id: who.id().to_owned(),
        agent_name: who.name().to_owned(),
        outcome,
        refs,
        purpose,
        reason,
        verified_by,
        peer_pid: peer.pid,
    }
}

// ---------------------------------------------------------------------------
// Event payloads

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
    /// `agent` or `user`.
    principal: &'static str,
    agent_id: Option<&'a str>,
    agent_name: &'a str,
    refs: &'a [SecretRef],
    /// Reported by `zv`, so show it as the requester's claim.
    purpose: &'a Purpose,
    peer_pid: Option<i32>,
    approval: Option<ApprovalMode>,
    /// Approving will also show the system Touch ID sheet.
    touch_id: bool,
    expires_in_secs: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefsPrompt<'a> {
    request_id: String,
    refs: &'a [SecretRef],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListPrompt<'a> {
    request_id: String,
    prefix: Option<&'a str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WritePrompt {
    request_id: String,
    reference: SecretRef,
    project_id: String,
    environment_id: String,
    secret_id: String,
    /// Sealed with the environment key, as `PutSecretRequest.values` wants it.
    encrypted_value: Blob,
    /// Present when the secret is new: its sealed `SecretMeta`.
    encrypted_meta: Option<Blob>,
    created: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let peer = check_peer(&server).unwrap();
        assert_eq!(peer.pid, Some(i32::try_from(std::process::id()).unwrap()));
        let my_sid = nix::unistd::getsid(None).unwrap().as_raw();
        assert_eq!(peer.sid, Some(my_sid));

        // A second bind while the first is live must not steal the socket.
        // (Its probe connection is left in the backlog, so this comes after
        // the accept above.)
        assert!(bind(&path).is_err());

        drop(listener);
        // A stale socket file is replaced.
        assert!(bind(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! Locks the vault on idle, sleep and screen lock.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard::ClipboardGuard;
use crate::session::{LockReason, Session};

pub const LOCKED_EVENT: &str = "vault://locked";

const TICK: Duration = Duration::from_secs(1);

/// A wall-clock jump this much larger than the monotonic clock's means the
/// machine was asleep (the monotonic clock stops during sleep on macOS and
/// Linux). Large enough to ignore NTP corrections.
const SLEEP_GAP: Duration = Duration::from_secs(30);

pub struct AppState {
    session: Mutex<Session>,
    pub clipboard: Arc<ClipboardGuard>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(Session::default()),
            clipboard: Arc::new(ClipboardGuard::default()),
        }
    }

    pub fn session(&self) -> MutexGuard<'_, Session> {
        // Recover from poisoning: the safe state after a panic is "locked",
        // and a poisoned mutex must not stop the lock path from running.
        self.session.lock().unwrap_or_else(|p| {
            let mut s = p.into_inner();
            s.lock();
            s
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockedEvent {
    reason: LockReason,
}

/// Locks the vault if `reason` applies under the current settings, clears any
/// secret we left on the clipboard, and tells the UI.
pub fn lock(app: &AppHandle, reason: LockReason) {
    let state = app.state::<AppState>();
    let was_unlocked = {
        let mut session = state.session();
        if !session.locks_on(reason) {
            return;
        }
        session.lock()
    };
    app.state::<crate::Keyring>().lock();
    crate::auth::forget(app);
    state.clipboard.clear_if_ours(None);
    if was_unlocked {
        let _ = app.emit(LOCKED_EVENT, LockedEvent { reason });
    }
}

/// Starts the OS listeners and the idle / sleep watcher. Call from `setup`,
/// which runs on the main thread.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    crate::platform::watch_system_events(move |reason| lock(&handle, reason));

    let handle = app.clone();
    std::thread::Builder::new()
        .name("zvault-autolock".into())
        .spawn(move || watch(&handle))
        .expect("failed to start the auto-lock thread");
}

fn watch(app: &AppHandle) {
    let mut last_mono = Instant::now();
    let mut last_wall = SystemTime::now();
    loop {
        std::thread::sleep(TICK);
        let mono = Instant::now();
        let wall = SystemTime::now();
        let gap = wall
            .duration_since(last_wall)
            .unwrap_or_default()
            .saturating_sub(mono - last_mono);
        last_mono = mono;
        last_wall = wall;

        if gap >= SLEEP_GAP {
            app.state::<AppState>().session().note_suspended(gap);
            lock(app, LockReason::Sleep);
        }
        if app.state::<AppState>().session().idle_expired(mono) {
            lock(app, LockReason::Idle);
        }
    }
}

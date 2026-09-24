//! OS integration. Everything that needs `unsafe` or a platform SDK lives in
//! a per-OS submodule; the rest of the crate only sees safe functions.

#[cfg(target_os = "macos")]
pub mod macos;

use crate::session::LockReason;

/// Calls `on_event` when the OS reports the machine is going to sleep or the
/// screen was locked. Must be called on the main thread.
///
/// On macOS this listens for `NSWorkspaceWillSleepNotification`,
/// `NSWorkspaceScreensDidSleepNotification`,
/// `NSWorkspaceSessionDidResignActiveNotification` (fast user switching) and
/// the `com.apple.screenIsLocked` distributed notification. Elsewhere it does
/// nothing; the auto-lock watcher's clock-gap check still catches sleep.
pub fn watch_system_events(on_event: impl Fn(LockReason) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    macos::events::watch(on_event);
    #[cfg(not(target_os = "macos"))]
    drop(on_event);
}

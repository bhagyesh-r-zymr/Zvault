//! The unlocked vault session and the rules that lock it again.
//!
//! This module is pure state: no threads, clocks or OS calls. Callers pass
//! `now` in, which keeps the auto-lock rules unit-testable.

use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use zvault_crypto::SymmetricKey;

/// Why the vault was locked. Sent to the UI with the `vault://locked` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    Manual,
    Idle,
    Sleep,
    /// Only macOS reports screen locks so far.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ScreenLocked,
}

/// How the current session was unlocked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnlockMethod {
    MasterPassword,
    TouchId,
}

/// User-adjustable lock behaviour. Every field is bounded so a bad value from
/// the UI can weaken protection only within limits we chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSettings {
    /// Lock after this many minutes without interacting with Zvault.
    pub idle_timeout_mins: u32,
    pub lock_on_sleep: bool,
    pub lock_on_screen_lock: bool,
    /// Clear a copied secret from the clipboard after this many seconds.
    pub clipboard_clear_secs: u32,
}

impl LockSettings {
    pub const IDLE_TIMEOUT_MINS: std::ops::RangeInclusive<u32> = 1..=480;
    pub const CLIPBOARD_CLEAR_SECS: std::ops::RangeInclusive<u32> = 10..=300;

    pub fn validate(&self) -> Result<(), &'static str> {
        if !Self::IDLE_TIMEOUT_MINS.contains(&self.idle_timeout_mins) {
            return Err("idle timeout must be between 1 and 480 minutes");
        }
        if !Self::CLIPBOARD_CLEAR_SECS.contains(&self.clipboard_clear_secs) {
            return Err("clipboard clear delay must be between 10 and 300 seconds");
        }
        Ok(())
    }

    pub fn idle_timeout(&self) -> Duration {
        Duration::from_secs(u64::from(self.idle_timeout_mins) * 60)
    }

    pub fn clipboard_clear_after(&self) -> Duration {
        Duration::from_secs(u64::from(self.clipboard_clear_secs))
    }
}

impl Default for LockSettings {
    fn default() -> Self {
        Self {
            idle_timeout_mins: 10,
            lock_on_sleep: true,
            lock_on_screen_lock: true,
            clipboard_clear_secs: 90,
        }
    }
}

struct Unlocked {
    account_id: String,
    /// The account unlock key. Wiped from memory when the session locks.
    key: SymmetricKey,
    method: UnlockMethod,
    /// When the master password was last proven, carried through Touch ID
    /// unlocks so quick unlock cannot extend itself forever.
    password_verified_at: SystemTime,
    last_activity: Instant,
    /// Time the machine spent asleep since `last_activity`. The monotonic
    /// clock stops during sleep, so this is added back for the idle check.
    suspended: Duration,
}

/// Locked unless an unlock key is held.
#[derive(Default)]
pub struct Session {
    unlocked: Option<Unlocked>,
    settings: LockSettings,
}

impl Session {
    pub fn is_locked(&self) -> bool {
        self.unlocked.is_none()
    }

    pub fn settings(&self) -> LockSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: LockSettings) -> Result<(), &'static str> {
        settings.validate()?;
        self.settings = settings;
        Ok(())
    }

    /// Starts a session. Callers must have verified `key` first (by unwrapping
    /// the account keyset with it); this type does not check it.
    pub fn unlock(
        &mut self,
        account_id: String,
        key: SymmetricKey,
        method: UnlockMethod,
        password_verified_at: SystemTime,
        now: Instant,
    ) {
        self.unlocked = Some(Unlocked {
            account_id,
            key,
            method,
            password_verified_at,
            last_activity: now,
            suspended: Duration::ZERO,
        });
    }

    /// Drops the key. Returns whether the session was unlocked.
    pub fn lock(&mut self) -> bool {
        self.unlocked.take().is_some()
    }

    /// Records user interaction with the app.
    pub fn touch(&mut self, now: Instant) {
        if let Some(u) = &mut self.unlocked {
            u.last_activity = now;
            u.suspended = Duration::ZERO;
        }
    }

    /// Records a sleep of `gap` that the monotonic clock did not see.
    pub fn note_suspended(&mut self, gap: Duration) {
        if let Some(u) = &mut self.unlocked {
            u.suspended = u.suspended.saturating_add(gap);
        }
    }

    pub fn idle_expired(&self, now: Instant) -> bool {
        self.unlocked.as_ref().is_some_and(|u| {
            now.saturating_duration_since(u.last_activity) + u.suspended
                >= self.settings.idle_timeout()
        })
    }

    /// Whether an OS event should lock the vault under the current settings.
    pub fn locks_on(&self, reason: LockReason) -> bool {
        match reason {
            LockReason::Manual | LockReason::Idle => true,
            LockReason::Sleep => self.settings.lock_on_sleep,
            LockReason::ScreenLocked => self.settings.lock_on_screen_lock,
        }
    }

    pub fn account_id(&self) -> Option<&str> {
        self.unlocked.as_ref().map(|u| u.account_id.as_str())
    }

    pub fn method(&self) -> Option<UnlockMethod> {
        self.unlocked.as_ref().map(|u| u.method)
    }

    /// The key and password-proof time, for enrolling Touch ID.
    pub fn key_for_enrollment(&self) -> Option<(&str, &SymmetricKey, SystemTime)> {
        self.unlocked
            .as_ref()
            .map(|u| (u.account_id.as_str(), &u.key, u.password_verified_at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unlocked(now: Instant) -> Session {
        let mut s = Session::default();
        s.unlock(
            "alice@example.com".into(),
            SymmetricKey::from_bytes([1; 32]),
            UnlockMethod::MasterPassword,
            SystemTime::UNIX_EPOCH,
            now,
        );
        s
    }

    #[test]
    fn starts_locked_and_lock_drops_the_key() {
        let t0 = Instant::now();
        assert!(Session::default().is_locked());
        let mut s = unlocked(t0);
        assert!(!s.is_locked());
        assert!(s.lock());
        assert!(s.is_locked());
        assert!(s.key_for_enrollment().is_none());
        assert!(!s.lock(), "locking twice reports nothing new");
    }

    #[test]
    fn idle_timeout_counts_from_last_activity() {
        let t0 = Instant::now();
        let mut s = unlocked(t0);
        let timeout = s.settings().idle_timeout();
        assert!(!s.idle_expired(t0 + timeout - Duration::from_secs(1)));
        assert!(s.idle_expired(t0 + timeout));

        s.touch(t0 + timeout - Duration::from_secs(1));
        assert!(!s.idle_expired(t0 + timeout));
    }

    #[test]
    fn sleep_time_counts_towards_idle_until_next_activity() {
        let t0 = Instant::now();
        let mut s = unlocked(t0);
        let timeout = s.settings().idle_timeout();
        s.note_suspended(timeout);
        assert!(s.idle_expired(t0));
        s.touch(t0);
        assert!(!s.idle_expired(t0));
    }

    #[test]
    fn locked_session_never_idles() {
        assert!(!Session::default().idle_expired(Instant::now() + Duration::from_secs(1 << 20)));
    }

    #[test]
    fn os_events_respect_settings() {
        let mut s = Session::default();
        assert!(s.locks_on(LockReason::Sleep));
        assert!(s.locks_on(LockReason::ScreenLocked));
        s.set_settings(LockSettings {
            lock_on_sleep: false,
            lock_on_screen_lock: false,
            ..LockSettings::default()
        })
        .unwrap();
        assert!(!s.locks_on(LockReason::Sleep));
        assert!(!s.locks_on(LockReason::ScreenLocked));
        assert!(s.locks_on(LockReason::Idle));
    }

    #[test]
    fn settings_are_bounded() {
        let mut s = Session::default();
        for bad in [
            LockSettings {
                idle_timeout_mins: 0,
                ..LockSettings::default()
            },
            LockSettings {
                idle_timeout_mins: 481,
                ..LockSettings::default()
            },
            LockSettings {
                clipboard_clear_secs: 5,
                ..LockSettings::default()
            },
            LockSettings {
                clipboard_clear_secs: 301,
                ..LockSettings::default()
            },
        ] {
            assert!(s.set_settings(bad).is_err());
        }
        assert_eq!(s.settings(), LockSettings::default());
    }
}

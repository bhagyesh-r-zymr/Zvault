//! Functions Flutter calls. Each takes and returns plain values; records from
//! the API are passed through as their JSON text.

pub mod pairing;
pub mod session;
pub mod sharing;
pub mod vault;

use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::keyring::Keyring;

static KEYRING: LazyLock<Mutex<Keyring>> = LazyLock::new(Mutex::default);

/// A panic while holding the lock can't leave keys half-written, so recovering
/// the guard is safe.
pub(crate) fn keyring() -> MutexGuard<'static, Keyring> {
    KEYRING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[flutter_rust_bridge::frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();
}

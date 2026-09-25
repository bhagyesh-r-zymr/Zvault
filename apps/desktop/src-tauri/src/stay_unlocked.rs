//! "Stay unlocked": Zvault opens unlocked after a quit or restart.
//!
//! Off by default. When it is on, every unlock saves the account keyset, the
//! server session token and the lock screen's unlock state to the macOS login
//! keychain. At launch the app reopens from that record instead of asking for
//! the master password.
//!
//! This is weaker than Touch ID: anyone signed in to this Mac user account can
//! open the vault. So the record is bounded the same way quick unlock is. It
//! expires [`crate::biometric::MAX_AGE`] after the master password was last
//! typed, it is deleted whenever the vault locks (a locked vault stays locked
//! after a restart), and turning the setting off deletes it at once.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};
use zvault_crypto::{KEY_LEN, SymmetricKey};

use crate::auth::LocalUnlock;
use crate::autolock::AppState;
use crate::session::UnlockMethod;

const RECORD_VERSION: u32 = 1;

/// The server session the UI gets back after a restore.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    email: String,
    token: String,
    expires_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    v: u32,
    email: String,
    /// The account keyset, base64url.
    keyset: String,
    /// Unix seconds when the master password was last typed.
    password_verified_at: u64,
    token: String,
    expires_at: String,
    local: Option<LocalUnlock>,
}

impl Drop for Record {
    fn drop(&mut self) {
        self.keyset.zeroize();
        self.token.zeroize();
    }
}

impl Record {
    fn encode(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        serde_json::to_vec(self)
            .map(Zeroizing::new)
            .map_err(|e| e.to_string())
    }

    fn decode(bytes: &[u8]) -> Option<Self> {
        let record: Self = serde_json::from_slice(bytes).ok()?;
        (record.v == RECORD_VERSION).then_some(record)
    }

    fn key(&self) -> Option<SymmetricKey> {
        let bytes = Zeroizing::new(B64.decode(&self.keyset).ok()?);
        let key: Zeroizing<[u8; KEY_LEN]> = Zeroizing::new(bytes.as_slice().try_into().ok()?);
        Some(SymmetricKey::from_bytes(*key))
    }

    fn verified_at(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(self.password_verified_at)
    }
}

/// Saves the unlocked session so the next launch opens unlocked. Does nothing
/// while "Stay unlocked" is off. The UI calls it after every unlock, with the
/// server session it holds.
#[tauri::command]
pub async fn stay_unlocked_save(
    app: AppHandle,
    token: String,
    expires_at: String,
) -> Result<(), String> {
    let record = {
        let state = app.state::<AppState>();
        let session = state.session();
        if !session.settings().stay_unlocked {
            return Ok(());
        }
        let (email, key, verified_at) = session.key_for_enrollment().ok_or("Zvault is locked")?;
        if !crate::biometric::is_fresh(verified_at, SystemTime::now()) {
            return Ok(());
        }
        Record {
            v: RECORD_VERSION,
            email: email.to_owned(),
            keyset: B64.encode(key.as_bytes()),
            password_verified_at: verified_at
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            token,
            expires_at,
            local: crate::auth::local_unlock(&app),
        }
    };
    let bytes = record.encode()?;
    // The Keychain can prompt after an unsigned update, so stay off the main thread.
    tauri::async_runtime::spawn_blocking(move || store::save(&bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// Reopens the vault from the saved session, if "Stay unlocked" is on and the
/// record is still fresh. Resolves to None when the person must sign in.
#[tauri::command]
pub async fn stay_unlocked_restore(app: AppHandle) -> Result<Option<RestoredSession>, String> {
    if !app.state::<AppState>().session().settings().stay_unlocked {
        return Ok(None);
    }
    let bytes = tauri::async_runtime::spawn_blocking(store::load)
        .await
        .map_err(|e| e.to_string())?;
    let Some(record) = bytes.as_deref().and_then(|b| Record::decode(b)) else {
        return Ok(None);
    };
    let fresh = crate::biometric::is_fresh(record.verified_at(), SystemTime::now());
    let (Some(key), true) = (record.key(), fresh) else {
        forget(&app);
        return Ok(None);
    };

    let keyset = crate::auth::copy_key(&key);
    app.state::<AppState>().session().unlock(
        record.email.clone(),
        key,
        UnlockMethod::Restored,
        record.verified_at(),
        Instant::now(),
    );
    app.state::<crate::Keyring>()
        .unlock(crate::auth::copy_key(&keyset));
    crate::auth::restore(&app, record.email.clone(), keyset, record.local.clone());
    Ok(Some(RestoredSession {
        email: record.email.clone(),
        token: record.token.clone(),
        expires_at: record.expires_at.clone(),
    }))
}

/// Deletes the saved session. Runs on its own thread because the lock path
/// can run on the main thread and a Keychain call may prompt.
pub(crate) fn forget(_app: &AppHandle) {
    std::thread::spawn(|| {
        let _ = store::delete();
    });
}

/// Where the record is kept: the login keychain on macOS. Other platforms
/// (CI, Linux dev builds) never stay unlocked.
mod store {
    #[cfg(target_os = "macos")]
    pub use crate::platform::macos::saved_session::{delete, load, save};

    #[cfg(not(target_os = "macos"))]
    pub fn save(_record: &[u8]) -> Result<(), String> {
        Err("Staying unlocked is only supported on macOS.".into())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn load() -> Option<zeroize::Zeroizing<Vec<u8>>> {
        None
    }

    #[cfg(not(target_os = "macos"))]
    pub fn delete() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        Record {
            v: RECORD_VERSION,
            email: "ada@example.com".into(),
            keyset: B64.encode([7u8; KEY_LEN]),
            password_verified_at: 1_790_000_000,
            token: "token".into(),
            expires_at: "2026-10-09T00:00:00.000Z".into(),
            local: None,
        }
    }

    #[test]
    fn round_trips() {
        let bytes = record().encode().unwrap();
        let back = Record::decode(&bytes).unwrap();
        assert_eq!(back.key().unwrap().as_bytes(), &[7u8; KEY_LEN]);
        assert_eq!(
            back.verified_at(),
            UNIX_EPOCH + Duration::from_secs(1_790_000_000)
        );
        assert_eq!(back.token, "token");
    }

    #[test]
    fn rejects_other_versions_and_bad_keys() {
        let mut r = record();
        r.v = 2;
        assert!(Record::decode(&r.encode().unwrap()).is_none());
        let mut r = record();
        r.keyset = B64.encode([7u8; 16]);
        assert!(r.key().is_none());
    }
}

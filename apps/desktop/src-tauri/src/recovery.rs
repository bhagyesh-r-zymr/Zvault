//! Changing the master password, setting up a recovery code, and recovering
//! an account with one. As with sign-in, passwords, the Secret Key and the
//! recovery code's keys stay in Rust; the UI gets back what it sends to the
//! server, plus the recovery code once, to show the person.
//!
//! Changing the password and setting up recovery both prove the current
//! master password to the server with a fresh SRP login for the account, and
//! check the server's proof before the change is taken as done.

use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
use zvault_crypto::srp::{self, ClientSession};
use zvault_crypto::{
    AccountKeys, KdfParams, RECOVERY_KID, RecoveryCode, RecoveryKeys, SecretKey, SymmetricKey,
    derive_account_keys, open_keyset, open_recovery_keyset, seal_keyset, seal_recovery_keyset,
};
use zvault_emergency_kit::{Date, RECOVERY_FILE_NAME, RecoveryKit};

use crate::auth::{
    self, BlobDto, KdfDto, LocalUnlock, WRONG_PASSWORD, blob, blob_with_kid, blocking, err,
    kdf_dto, kdf_params, sealed,
};

const LOCKED: &str = "Unlock Zvault first.";
const NO_SECRET_KEY: &str = "This Mac doesn't have your Secret Key saved. Sign out, then sign in \
     with your Emergency Kit, and try again.";
const SERVER_UNPROVEN: &str = "Zvault couldn't confirm the server's reply. Sign out and sign in \
     again to check the change.";
const BAD_CODE: &str = "That recovery code doesn't look right. It starts with R1 and has six \
     groups of five characters.";
const CODE_MISMATCH: &str = "That recovery code doesn't open this account. Check it and try again.";
const START_AGAIN: &str = "This recovery has expired. Start again.";

/// What a password change or recovery setup uploads, with its proof of the
/// current master password.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    srp_a: String,
    srp_m1: String,
    kdf: KdfDto,
    srp_verifier: String,
    encrypted_keyset: BlobDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySetup {
    srp_a: String,
    srp_m1: String,
    recovery_keyset: BlobDto,
    recovery_verifier: String,
}

/// Everything `recover/complete` uploads. The new Secret Key and recovery
/// code stay in Rust until the server accepts them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredAccount {
    secret_key_id: String,
    kdf: KdfDto,
    srp_verifier: String,
    encrypted_keyset: BlobDto,
    recovery_keyset: BlobDto,
    recovery_verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    email: String,
    /// Shown once so the person can write it down. Never send it anywhere.
    recovery_code: String,
}

struct PendingChange {
    srp: ClientSession,
    local: LocalUnlock,
}

struct PendingSetup {
    srp: ClientSession,
    email: String,
    code: RecoveryCode,
}

struct PendingRecover {
    email: String,
    keys: RecoveryKeys,
}

struct PendingReset {
    email: String,
    keyset: SymmetricKey,
    secret_key: SecretKey,
    code: RecoveryCode,
    local: LocalUnlock,
}

/// Work in progress between commands. Dropping it zeroizes every key.
#[derive(Default)]
struct Inner {
    change: Option<PendingChange>,
    setup: Option<PendingSetup>,
    recover: Option<PendingRecover>,
    reset: Option<PendingReset>,
    /// A recovery code the server accepted, until the person saves it.
    staged: Option<(String, RecoveryCode)>,
}

#[derive(Default)]
pub struct RecoveryState(Mutex<Inner>);

fn lock(state: &RecoveryState) -> std::sync::MutexGuard<'_, Inner> {
    state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The signed-in account, a copy of its keyset and the sealed keyset kept for
/// the lock screen, which checks the current password without the server.
struct Current {
    email: String,
    keyset: SymmetricKey,
    local: Option<BlobDto>,
    secret_key: SecretKey,
}

fn current(app: &AppHandle) -> Result<Current, String> {
    let (email, keyset) = auth::with_account(app, |email, keyset| {
        (email.to_owned(), auth::copy_key(keyset))
    })
    .ok_or(LOCKED)?;
    let local = auth::local_unlock(app)
        .filter(|l| l.email == email)
        .map(|l| l.encrypted_keyset);
    let secret_key = crate::remembered::key_for(app, &email).ok_or(NO_SECRET_KEY)?;
    Ok(Current {
        email,
        keyset,
        local,
        secret_key,
    })
}

/// Derives the current keys and answers the server's challenge with them.
/// Checks the password locally first when it can, so a typo never reaches the
/// server.
fn prove_current(
    cur: &Current,
    password: &str,
    kdf: &KdfParams,
    srp_b: &[u8],
) -> Result<ClientSession, String> {
    let keys: AccountKeys =
        derive_account_keys(password, &cur.secret_key, &cur.email, kdf).map_err(err)?;
    if let Some(local) = cur.local.as_ref().and_then(sealed) {
        open_keyset(&keys.unlock_key, &local, &cur.email).map_err(|_| WRONG_PASSWORD)?;
    }
    ClientSession::new(&cur.email, &kdf.salt, &keys.srp_x, srp_b).map_err(|_| WRONG_PASSWORD.into())
}

fn server_b(srp_b: &str) -> Result<Vec<u8>, String> {
    B64.decode(srp_b).map_err(|_| WRONG_PASSWORD.to_string())
}

fn check_server(srp: &ClientSession, srp_m2: &str) -> Result<(), String> {
    let m2 = B64.decode(srp_m2).map_err(|_| SERVER_UNPROVEN)?;
    srp.verify_server(&m2).map_err(|_| SERVER_UNPROVEN.into())
}

/// Step 1 of a password change: proves the current password and seals the
/// same keyset under the new one. Runs Argon2id twice, so it takes a couple
/// of seconds. `kdf` and `srp_b` come from `auth/login/start`.
#[tauri::command]
pub async fn password_change_prove(
    app: AppHandle,
    current_password: String,
    new_password: String,
    kdf: KdfDto,
    srp_b: String,
) -> Result<PasswordChange, String> {
    let current_password = Zeroizing::new(current_password);
    let new_password = Zeroizing::new(new_password);
    let params = kdf_params(&kdf).map_err(|_| WRONG_PASSWORD)?;
    let public_b = server_b(&srp_b)?;
    let lookup = app.clone();
    let (change, pending) = blocking(move || {
        let cur = current(&lookup)?;
        let srp = prove_current(&cur, &current_password, &params, &public_b)?;
        let new_kdf = KdfParams::generate_default().map_err(err)?;
        let keys = derive_account_keys(&new_password, &cur.secret_key, &cur.email, &new_kdf)
            .map_err(err)?;
        let sealed = seal_keyset(&keys.unlock_key, &cur.keyset, &cur.email).map_err(err)?;
        let change = PasswordChange {
            srp_a: B64.encode(srp.public_a()),
            srp_m1: B64.encode(srp.proof()),
            kdf: kdf_dto(&new_kdf),
            srp_verifier: B64.encode(srp::verifier(&keys.srp_x)),
            encrypted_keyset: blob(&sealed),
        };
        let local = LocalUnlock {
            email: cur.email.clone(),
            kdf: kdf_dto(&new_kdf),
            encrypted_keyset: blob(&sealed),
        };
        Ok((change, PendingChange { srp, local }))
    })
    .await?;
    lock(&app.state::<RecoveryState>()).change = Some(pending);
    Ok(change)
}

/// Step 2: checks the server's proof, then unlocks with the new password from
/// now on.
#[tauri::command]
pub fn password_change_finish(
    app: AppHandle,
    state: State<'_, RecoveryState>,
    srp_m2: String,
) -> Result<(), String> {
    let pending = lock(&state).change.take().ok_or(START_AGAIN)?;
    check_server(&pending.srp, &srp_m2)?;
    auth::replace_local_unlock(&app, pending.local);
    Ok(())
}

/// Step 1 of setting up (or replacing) the recovery code: proves the current
/// password and seals a recovery copy of the keyset with a new code.
#[tauri::command]
pub async fn recovery_setup_prove(
    app: AppHandle,
    password: String,
    kdf: KdfDto,
    srp_b: String,
) -> Result<RecoverySetup, String> {
    let password = Zeroizing::new(password);
    let params = kdf_params(&kdf).map_err(|_| WRONG_PASSWORD)?;
    let public_b = server_b(&srp_b)?;
    let lookup = app.clone();
    let (setup, pending) = blocking(move || {
        let cur = current(&lookup)?;
        let srp = prove_current(&cur, &password, &params, &public_b)?;
        let code = RecoveryCode::generate().map_err(err)?;
        let keys = code.keys(&cur.email);
        let sealed = seal_recovery_keyset(&keys, &cur.keyset, &cur.email).map_err(err)?;
        let setup = RecoverySetup {
            srp_a: B64.encode(srp.public_a()),
            srp_m1: B64.encode(srp.proof()),
            recovery_keyset: blob_with_kid(&sealed, RECOVERY_KID),
            recovery_verifier: B64.encode(keys.verifier()),
        };
        Ok((
            setup,
            PendingSetup {
                srp,
                email: cur.email,
                code,
            },
        ))
    })
    .await?;
    lock(&app.state::<RecoveryState>()).setup = Some(pending);
    Ok(setup)
}

/// Step 2: checks the server's proof and returns the new code to show once.
/// It stays staged for the Recovery Kit PDF until [`discard_recovery_code`].
#[tauri::command]
pub fn recovery_setup_finish(
    state: State<'_, RecoveryState>,
    srp_m2: String,
) -> Result<String, String> {
    let mut inner = lock(&state);
    let pending = inner.setup.take().ok_or(START_AGAIN)?;
    check_server(&pending.srp, &srp_m2)?;
    let shown = pending.code.to_display_string().to_string();
    inner.staged = Some((pending.email, pending.code));
    Ok(shown)
}

/// Asks where to save the Recovery Kit and writes it. Returns `false` if the
/// person cancelled the dialog.
#[tauri::command]
pub async fn save_recovery_kit<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let pdf = {
        let state = app.state::<RecoveryState>();
        let inner = lock(&state);
        let (email, code) = inner
            .staged
            .as_ref()
            .ok_or("There's no new recovery code to save.")?;
        RecoveryKit {
            email,
            recovery_code: code,
            created_on: Date::today(),
        }
        .render()
        .map_err(|e| e.to_string())?
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Save your Recovery Kit")
        .set_file_name(RECOVERY_FILE_NAME)
        .add_filter("PDF document", &["pdf"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    crate::emergency_kit::write_private(&path, &pdf)
        .map_err(|e| format!("Couldn't save the Recovery Kit: {e}"))?;
    Ok(true)
}

/// Forgets the staged recovery code once the person has saved it.
#[tauri::command]
pub fn discard_recovery_code(state: State<'_, RecoveryState>) {
    lock(&state).staged.take();
}

/// Recovery step 1, signed out: reads the recovery code and returns the auth
/// token the server checks. The wrap key stays here for [`recover_reset`].
#[tauri::command]
pub fn recover_begin(
    state: State<'_, RecoveryState>,
    email: String,
    recovery_code: String,
) -> Result<String, String> {
    let code = RecoveryCode::parse(&Zeroizing::new(recovery_code)).map_err(|_| BAD_CODE)?;
    let email = zvault_crypto::normalize_account_id(&email);
    let keys = code.keys(&email);
    let auth_token = B64.encode(keys.auth_token.as_bytes());
    let mut inner = lock(&state);
    inner.reset = None;
    inner.recover = Some(PendingRecover { email, keys });
    Ok(auth_token)
}

/// Recovery step 2: opens the recovery copy the server released, and makes a
/// new master password, Secret Key and recovery code for the same keyset.
#[tauri::command]
pub async fn recover_reset(
    app: AppHandle,
    new_password: String,
    recovery_keyset: BlobDto,
) -> Result<RecoveredAccount, String> {
    let new_password = Zeroizing::new(new_password);
    let recover = lock(&app.state::<RecoveryState>())
        .recover
        .take()
        .ok_or(START_AGAIN)?;
    let (account, reset) = blocking(move || {
        let email = recover.email;
        let sealed_copy = sealed(&recovery_keyset).ok_or(CODE_MISMATCH)?;
        let keyset =
            open_recovery_keyset(&recover.keys, &sealed_copy, &email).map_err(|_| CODE_MISMATCH)?;

        let secret_key = SecretKey::generate().map_err(err)?;
        let kdf = KdfParams::generate_default().map_err(err)?;
        let keys = derive_account_keys(&new_password, &secret_key, &email, &kdf).map_err(err)?;
        let sealed_keyset = seal_keyset(&keys.unlock_key, &keyset, &email).map_err(err)?;
        let code = RecoveryCode::generate().map_err(err)?;
        let recovery_keys = code.keys(&email);
        let recovery_copy = seal_recovery_keyset(&recovery_keys, &keyset, &email).map_err(err)?;

        let account = RecoveredAccount {
            secret_key_id: secret_key.id().to_owned(),
            kdf: kdf_dto(&kdf),
            srp_verifier: B64.encode(srp::verifier(&keys.srp_x)),
            encrypted_keyset: blob(&sealed_keyset),
            recovery_keyset: blob_with_kid(&recovery_copy, RECOVERY_KID),
            recovery_verifier: B64.encode(recovery_keys.verifier()),
        };
        let local = LocalUnlock {
            email: email.clone(),
            kdf: kdf_dto(&kdf),
            encrypted_keyset: blob(&sealed_keyset),
        };
        Ok((
            account,
            PendingReset {
                email,
                keyset,
                secret_key,
                code,
                local,
            },
        ))
    })
    .await?;
    lock(&app.state::<RecoveryState>()).reset = Some(reset);
    Ok(account)
}

/// Recovery step 3, after the server accepted the reset: unlocks, saves the
/// new Secret Key to this Mac and stages it for the new Emergency Kit, and
/// returns the new recovery code to show once.
#[tauri::command]
pub fn recover_finish(app: AppHandle) -> Result<Recovered, String> {
    let reset = lock(&app.state::<RecoveryState>())
        .reset
        .take()
        .ok_or(START_AGAIN)?;
    let PendingReset {
        email,
        keyset,
        secret_key,
        code,
        local,
    } = reset;
    crate::remembered::remember(&app, &email, &secret_key);
    crate::stage_secret_key(&app, secret_key);
    auth::unlock_after_recovery(&app, email.clone(), keyset, local);
    let recovery_code = code.to_display_string().to_string();
    lock(&app.state::<RecoveryState>()).staged = Some((email.clone(), code));
    Ok(Recovered {
        email,
        recovery_code,
    })
}

/// Drops a recovery in progress, for example when the person goes back.
#[tauri::command]
pub fn recover_cancel(state: State<'_, RecoveryState>) {
    let mut inner = lock(&state);
    inner.recover = None;
    inner.reset = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> KdfParams {
        KdfParams {
            memory_kib: KdfParams::MIN_MEMORY_KIB,
            iterations: KdfParams::MIN_ITERATIONS,
            parallelism: 1,
            salt: [3; zvault_crypto::SALT_LEN],
        }
    }

    #[test]
    fn a_wrong_current_password_fails_before_the_server_sees_it() {
        let secret_key = SecretKey::generate().unwrap();
        let keyset = SymmetricKey::generate().unwrap();
        let keys = derive_account_keys("right password", &secret_key, "a@b.co", &params()).unwrap();
        let local = seal_keyset(&keys.unlock_key, &keyset, "a@b.co").unwrap();
        let cur = Current {
            email: "a@b.co".into(),
            keyset,
            local: Some(blob(&local)),
            secret_key,
        };
        // Any valid group element will do for B here.
        let b = srp::verifier(&SymmetricKey::generate().unwrap());
        assert_eq!(
            prove_current(&cur, "wrong password", &params(), &b).err(),
            Some(WRONG_PASSWORD.to_owned())
        );
        assert!(prove_current(&cur, "right password", &params(), &b).is_ok());
    }
}

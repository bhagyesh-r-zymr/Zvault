//! Sign-up and login commands. The master password and Secret Key are used
//! here and nowhere else; the web UI gets back only what it must send to the
//! server or show the user.

use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;
use zvault_crypto::srp::{self, ClientSession};
use zvault_crypto::{
    KEYSET_KID, KdfParams, NONCE_LEN, SALT_LEN, Sealed, SecretKey, SymmetricKey,
    derive_account_keys, normalize_account_id, open_keyset, seal_keyset,
};

/// Must match `CRYPTO_VERSION` in `@zvault/shared`.
pub const CRYPTO_VERSION: u32 = 1;

/// Mirrors `KdfParams` in `@zvault/shared`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfDto {
    alg: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

/// Mirrors `EncryptedBlob` in `@zvault/shared`.
#[derive(Serialize, Deserialize)]
pub struct BlobDto {
    v: u32,
    alg: String,
    kid: String,
    nonce: String,
    ct: String,
}

/// Everything sign-up uploads, plus the Secret Key for the Emergency Kit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    /// Shown once on the Emergency Kit. Never sent to the server.
    secret_key: String,
    secret_key_id: String,
    kdf: KdfDto,
    srp_verifier: String,
    encrypted_keyset: BlobDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProof {
    srp_a: String,
    srp_m1: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unlocked {
    email: String,
}

struct PendingLogin {
    email: String,
    srp: ClientSession,
    unlock_key: SymmetricKey,
}

struct Account {
    email: String,
    /// Unwraps vault keys once vaults exist.
    #[allow(dead_code)]
    keyset: SymmetricKey,
}

/// Key material held by the app between commands. Dropping it zeroizes it.
#[derive(Default)]
pub struct AuthState {
    pending: Option<PendingLogin>,
    account: Option<Account>,
}

type AppState<'a> = State<'a, Mutex<AuthState>>;

/// The one message shown for any login failure, so it can't tell an attacker
/// which input was wrong.
const LOGIN_FAILED: &str = "Incorrect email, master password or Secret Key.";

/// Creates a new account's keys: a Secret Key, KDF salt, SRP verifier and a
/// sealed keyset. Runs Argon2id, so it takes about a second.
#[tauri::command]
pub async fn create_account(
    app: tauri::AppHandle,
    email: String,
    password: String,
) -> Result<NewAccount, String> {
    let password = Zeroizing::new(password);
    let (account, secret_key) = blocking(move || {
        let secret_key = SecretKey::generate().map_err(err)?;
        let kdf = KdfParams::generate_default().map_err(err)?;
        let keys = derive_account_keys(&password, &secret_key, &email, &kdf).map_err(err)?;
        let keyset = SymmetricKey::generate().map_err(err)?;
        let sealed = seal_keyset(&keys.unlock_key, &keyset, &email).map_err(err)?;
        let account = NewAccount {
            secret_key: secret_key.to_display_string().to_string(),
            secret_key_id: secret_key.id().to_owned(),
            kdf: KdfDto {
                alg: "argon2id".into(),
                memory_kib: kdf.memory_kib,
                iterations: kdf.iterations,
                parallelism: kdf.parallelism,
                salt: B64.encode(kdf.salt),
            },
            srp_verifier: B64.encode(srp::verifier(&keys.srp_x)),
            encrypted_keyset: blob(&sealed),
        };
        Ok((account, secret_key))
    })
    .await?;
    // Held in Rust for the Emergency Kit PDF until the person confirms it's saved.
    crate::stage_secret_key(&app, secret_key);
    Ok(account)
}

/// Login step 1: derives the keys and answers the server's SRP challenge.
#[tauri::command]
pub async fn login_prove(
    state: AppState<'_>,
    email: String,
    password: String,
    secret_key: String,
    kdf: KdfDto,
    srp_b: String,
) -> Result<LoginProof, String> {
    let password = Zeroizing::new(password);
    let secret_key = SecretKey::parse(&Zeroizing::new(secret_key))
        .map_err(|_| "That Secret Key doesn't look right. Check your Emergency Kit.".to_string())?;
    let params = kdf_params(&kdf)?;
    let public_b = B64.decode(srp_b).map_err(|_| LOGIN_FAILED.to_string())?;
    let email = normalize_account_id(&email);

    let pending = blocking(move || {
        let keys = derive_account_keys(&password, &secret_key, &email, &params).map_err(err)?;
        let srp = ClientSession::new(&email, &params.salt, &keys.srp_x, &public_b)
            .map_err(|_| LOGIN_FAILED.to_string())?;
        Ok(PendingLogin {
            email,
            srp,
            unlock_key: keys.unlock_key,
        })
    })
    .await?;

    let proof = LoginProof {
        srp_a: B64.encode(pending.srp.public_a()),
        srp_m1: B64.encode(pending.srp.proof()),
    };
    lock_state(&state)?.pending = Some(pending);
    Ok(proof)
}

/// Login step 2: checks the server's proof, then opens the keyset.
#[tauri::command]
pub fn login_finish(
    app: AppHandle,
    state: AppState<'_>,
    srp_m2: String,
    encrypted_keyset: BlobDto,
) -> Result<Unlocked, String> {
    let mut auth = lock_state(&state)?;
    let pending = auth.pending.take().ok_or(LOGIN_FAILED)?;
    let m2 = B64.decode(srp_m2).map_err(|_| LOGIN_FAILED)?;
    // A server that can't produce M2 doesn't hold our verifier: stop here.
    pending.srp.verify_server(&m2).map_err(|_| LOGIN_FAILED)?;
    let sealed = sealed(&encrypted_keyset).ok_or(LOGIN_FAILED)?;
    let keyset =
        open_keyset(&pending.unlock_key, &sealed, &pending.email).map_err(|_| LOGIN_FAILED)?;
    let email = pending.email.clone();
    app.state::<crate::Keyring>().unlock(copy_key(&keyset));
    crate::commands::unlocked_with_password(
        &app,
        &app.state::<crate::autolock::AppState>(),
        email.clone(),
        copy_key(&keyset),
    );
    auth.account = Some(Account {
        email: email.clone(),
        keyset,
    });
    Ok(Unlocked { email })
}

/// Locks the vault and forgets all key material.
#[tauri::command]
pub fn lock(app: AppHandle, state: AppState<'_>) -> Result<(), String> {
    crate::autolock::lock(&app, crate::session::LockReason::Manual);
    *lock_state(&state)? = AuthState::default();
    Ok(())
}

/// Drops the unlocked account. The auto-lock path calls this.
pub(crate) fn forget(app: &AppHandle) {
    let state = app.state::<Mutex<AuthState>>();
    let mut auth = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *auth = AuthState::default();
}

/// Reopens the account after a quick unlock (Touch ID) handed back its keyset.
pub(crate) fn restore(app: &AppHandle, email: String, keyset: SymmetricKey) {
    let state = app.state::<Mutex<AuthState>>();
    let mut auth = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    auth.pending = None;
    auth.account = Some(Account { email, keyset });
}

/// A second handle on the same key, for the parts of the app that each hold one.
pub(crate) fn copy_key(key: &SymmetricKey) -> SymmetricKey {
    SymmetricKey::from_bytes(*key.as_bytes())
}

/// The unlocked account, if any.
#[tauri::command]
pub fn unlocked(state: AppState<'_>) -> Result<Option<Unlocked>, String> {
    Ok(lock_state(&state)?.account.as_ref().map(|a| Unlocked {
        email: a.email.clone(),
    }))
}

fn lock_state<'a>(state: &'a AppState<'_>) -> Result<std::sync::MutexGuard<'a, AuthState>, String> {
    state.lock().map_err(|_| "internal error".to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "internal error".to_string())?
}

fn err(e: zvault_crypto::Error) -> String {
    e.to_string()
}

fn kdf_params(kdf: &KdfDto) -> Result<KdfParams, String> {
    let salt: [u8; SALT_LEN] = B64
        .decode(&kdf.salt)
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or(LOGIN_FAILED)?;
    if kdf.alg != "argon2id" {
        return Err(LOGIN_FAILED.into());
    }
    Ok(KdfParams {
        memory_kib: kdf.memory_kib,
        iterations: kdf.iterations,
        parallelism: kdf.parallelism,
        salt,
    })
}

fn blob(sealed: &Sealed) -> BlobDto {
    BlobDto {
        v: CRYPTO_VERSION,
        alg: "xchacha20poly1305".into(),
        kid: KEYSET_KID.into(),
        nonce: B64.encode(sealed.nonce),
        ct: B64.encode(&sealed.ciphertext),
    }
}

fn sealed(blob: &BlobDto) -> Option<Sealed> {
    if blob.v != CRYPTO_VERSION || blob.alg != "xchacha20poly1305" {
        return None;
    }
    let nonce: [u8; NONCE_LEN] = B64.decode(&blob.nonce).ok()?.try_into().ok()?;
    let ciphertext = B64.decode(&blob.ct).ok()?;
    Some(Sealed { nonce, ciphertext })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trips() {
        let sealed = Sealed {
            nonce: [1; NONCE_LEN],
            ciphertext: vec![2; 48],
        };
        assert_eq!(super::sealed(&blob(&sealed)), Some(sealed));
    }

    #[test]
    fn rejects_foreign_blobs() {
        let mut b = blob(&Sealed {
            nonce: [1; NONCE_LEN],
            ciphertext: vec![2; 48],
        });
        b.v = 2;
        assert!(sealed(&b).is_none());
    }

    #[test]
    fn rejects_bad_kdf_salts() {
        let kdf = KdfDto {
            alg: "argon2id".into(),
            memory_kib: 65536,
            iterations: 3,
            parallelism: 1,
            salt: B64.encode([0u8; 8]),
        };
        assert!(kdf_params(&kdf).is_err());
    }
}

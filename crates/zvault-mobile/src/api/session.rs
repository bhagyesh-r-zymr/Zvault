//! Unlocking and locking.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use zeroize::Zeroizing;
use zvault_crypto::{KEY_LEN, SymmetricKey};

use super::keyring;

/// Unlocks with the keyset the phone kept in its biometric-protected store.
pub fn unlock(email: String, keyset: String) -> anyhow::Result<()> {
    let bytes = Zeroizing::new(B64.decode(keyset.as_bytes())?);
    let key: [u8; KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))?;
    keyring().unlock(email, SymmetricKey::from_bytes(key));
    Ok(())
}

/// Wipes every key.
#[flutter_rust_bridge::frb(sync)]
pub fn lock() {
    keyring().lock();
}

/// The unlocked account's email, or None while locked.
#[flutter_rust_bridge::frb(sync)]
pub fn unlocked_email() -> Option<String> {
    keyring().email().map(str::to_owned)
}

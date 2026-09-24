use crate::{Result, Sealed, SymmetricKey, kdf::normalize_account_id, open, seal};

/// Key id carried on the sealed keyset's `EncryptedBlob`.
pub const KEYSET_KID: &str = "keyset";

/// Binds the sealed keyset to its account so the server can't hand one
/// account's keyset to another.
fn aad(account_id: &str) -> Vec<u8> {
    format!("zvault/v1/keyset/{}", normalize_account_id(account_id)).into_bytes()
}

/// Seals the account keyset with the unlock key for storage on the server.
pub fn seal_keyset(
    unlock_key: &SymmetricKey,
    keyset: &SymmetricKey,
    account_id: &str,
) -> Result<Sealed> {
    seal(unlock_key, keyset.as_bytes(), &aad(account_id))
}

/// Opens the keyset returned at login. Fails on a wrong unlock key or a
/// keyset belonging to another account.
pub fn open_keyset(
    unlock_key: &SymmetricKey,
    sealed: &Sealed,
    account_id: &str,
) -> Result<SymmetricKey> {
    let bytes = zeroize::Zeroizing::new(open(unlock_key, sealed, &aad(account_id))?);
    let key: [u8; crate::KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| crate::Error::Decrypt)?;
    Ok(SymmetricKey::from_bytes(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn round_trips_and_is_bound_to_the_account() {
        let unlock = SymmetricKey::generate().unwrap();
        let keyset = SymmetricKey::generate().unwrap();
        let sealed = seal_keyset(&unlock, &keyset, "Alice@Example.com").unwrap();

        let opened = open_keyset(&unlock, &sealed, "alice@example.com").unwrap();
        assert_eq!(opened.as_bytes(), keyset.as_bytes());
        assert!(matches!(
            open_keyset(&unlock, &sealed, "bob@example.com"),
            Err(Error::Decrypt)
        ));
        let other = SymmetricKey::generate().unwrap();
        assert!(matches!(
            open_keyset(&other, &sealed, "alice@example.com"),
            Err(Error::Decrypt)
        ));
    }
}

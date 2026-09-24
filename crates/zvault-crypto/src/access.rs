//! Team access to environments.
//!
//! Every environment has its own random 256-bit key, and secrets in it are
//! sealed under that key. Giving someone access means *wrapping* the key to
//! their X25519 sharing key with the same sender-authenticated box used for
//! user shares ([`crate::seal_to`]), under separate labels so a wrapped
//! environment key can never be passed off as a share, or the reverse.
//!
//! The associated data binds each wrap to its environment id and key version,
//! so the server cannot move a wrap to another environment or roll someone
//! back to a key version they were removed from. Groups have no keys of their
//! own: a group grant is carried out by wrapping to each member.
//!
//! Revoking access cannot take back a key someone already unwrapped, so
//! whenever a principal loses access a manager's device *rotates*: it
//! generates the next key version, re-seals the environment's secrets and
//! wraps the new key to everyone who still has access.
//!
//! Approval-gated access ("Needs approval") never gets a standing wrap. When a
//! manager approves a request, their device seals just the requested values
//! to the requester with [`seal_release`].

use zeroize::Zeroizing;

use crate::share::{open_box, seal_box};
use crate::{BoxedShare, Error, KEY_LEN, PUBLIC_KEY_LEN, Result, SharingKeyPair, SymmetricKey};

/// Environment ids and access request ids are UUIDs: 16 bytes.
pub const ACCESS_ID_LEN: usize = 16;

const WRAP_INFO: &[u8] = b"zvault/v1/env-key-wrap";
const WRAP_AAD_PREFIX: &[u8] = b"zvault/v1/env-key-wrap:";
const RELEASE_INFO: &[u8] = b"zvault/v1/access-release";
const RELEASE_AAD_PREFIX: &[u8] = b"zvault/v1/access-release:";

fn wrap_aad(environment_id: &[u8; ACCESS_ID_LEN], key_version: u32) -> Vec<u8> {
    [WRAP_AAD_PREFIX, environment_id, &key_version.to_be_bytes()].concat()
}

/// A fresh key for a new environment, or for the next version on rotation.
pub fn generate_environment_key() -> Result<SymmetricKey> {
    SymmetricKey::generate()
}

/// Wraps `key` (version `key_version` of `environment_id`) from a manager to
/// one member or agent.
pub fn wrap_environment_key(
    wrapper: &SharingKeyPair,
    recipient_public: &[u8; PUBLIC_KEY_LEN],
    environment_id: &[u8; ACCESS_ID_LEN],
    key_version: u32,
    key: &SymmetricKey,
) -> Result<BoxedShare> {
    seal_box(
        WRAP_INFO,
        &wrap_aad(environment_id, key_version),
        wrapper,
        recipient_public,
        key.as_bytes(),
    )
}

/// Unwraps an environment key. Fails unless the holder of `wrapper_public`
/// wrapped it to `recipient` for exactly this environment and key version.
pub fn unwrap_environment_key(
    recipient: &SharingKeyPair,
    wrapper_public: &[u8; PUBLIC_KEY_LEN],
    environment_id: &[u8; ACCESS_ID_LEN],
    key_version: u32,
    wrapped: &BoxedShare,
) -> Result<SymmetricKey> {
    let bytes = Zeroizing::new(open_box(
        WRAP_INFO,
        &wrap_aad(environment_id, key_version),
        recipient,
        wrapper_public,
        wrapped,
    )?);
    let key: [u8; KEY_LEN] = bytes.as_slice().try_into().map_err(|_| Error::Decrypt)?;
    Ok(SymmetricKey::from_bytes(key))
}

/// Seals the values an approved request asked for, from the approving manager
/// to the requester, bound to the request id.
pub fn seal_release(
    approver: &SharingKeyPair,
    requester_public: &[u8; PUBLIC_KEY_LEN],
    request_id: &[u8; ACCESS_ID_LEN],
    plaintext: &[u8],
) -> Result<BoxedShare> {
    seal_box(
        RELEASE_INFO,
        &[RELEASE_AAD_PREFIX, request_id].concat(),
        approver,
        requester_public,
        plaintext,
    )
}

/// Opens values released for `request_id` by the holder of `approver_public`.
pub fn open_release(
    requester: &SharingKeyPair,
    approver_public: &[u8; PUBLIC_KEY_LEN],
    request_id: &[u8; ACCESS_ID_LEN],
    released: &BoxedShare,
) -> Result<Vec<u8>> {
    open_box(
        RELEASE_INFO,
        &[RELEASE_AAD_PREFIX, request_id].concat(),
        requester,
        approver_public,
        released,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SHARE_ID_LEN, open_from};

    const ENV: [u8; ACCESS_ID_LEN] = [0xE1; ACCESS_ID_LEN];

    #[test]
    fn wrapped_key_round_trips_to_a_member() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let wrapped = wrap_environment_key(&manager, &member.public_key(), &ENV, 1, &key).unwrap();
        let unwrapped =
            unwrap_environment_key(&member, &manager.public_key(), &ENV, 1, &wrapped).unwrap();
        assert_eq!(unwrapped.as_bytes(), key.as_bytes());
    }

    #[test]
    fn wrap_is_bound_to_environment_version_wrapper_and_recipient() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let mallory = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let wrapped = wrap_environment_key(&manager, &member.public_key(), &ENV, 2, &key).unwrap();

        let other_env = [0xE2; ACCESS_ID_LEN];
        for result in [
            // Moved to another environment.
            unwrap_environment_key(&member, &manager.public_key(), &other_env, 2, &wrapped),
            // Replayed as a different key version.
            unwrap_environment_key(&member, &manager.public_key(), &ENV, 1, &wrapped),
            // The server claims someone else wrapped it.
            unwrap_environment_key(&member, &mallory.public_key(), &ENV, 2, &wrapped),
            // Someone else tries to open it.
            unwrap_environment_key(&mallory, &manager.public_key(), &ENV, 2, &wrapped),
        ] {
            assert!(matches!(result, Err(Error::Decrypt)));
        }
    }

    #[test]
    fn wraps_and_shares_cannot_be_confused() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let wrapped = wrap_environment_key(&manager, &member.public_key(), &ENV, 1, &key).unwrap();
        let share_id: [u8; SHARE_ID_LEN] = ENV;
        assert_eq!(
            open_from(&member, &manager.public_key(), &share_id, &wrapped),
            Err(Error::Decrypt)
        );
        assert_eq!(
            open_release(&member, &manager.public_key(), &ENV, &wrapped),
            Err(Error::Decrypt)
        );
    }

    #[test]
    fn released_values_open_only_for_their_request() {
        let manager = SharingKeyPair::generate().unwrap();
        let agent = SharingKeyPair::generate().unwrap();
        let request = [0xA1; ACCESS_ID_LEN];
        let released = seal_release(
            &manager,
            &agent.public_key(),
            &request,
            b"STRIPE_KEY=sk_test",
        )
        .unwrap();
        assert_eq!(
            open_release(&agent, &manager.public_key(), &request, &released).unwrap(),
            b"STRIPE_KEY=sk_test"
        );
        assert_eq!(
            open_release(
                &agent,
                &manager.public_key(),
                &[0xA2; ACCESS_ID_LEN],
                &released
            ),
            Err(Error::Decrypt)
        );
    }

    #[test]
    fn rotated_key_differs_and_old_wrap_does_not_open_as_new_version() {
        let manager = SharingKeyPair::generate().unwrap();
        let v1 = generate_environment_key().unwrap();
        let v2 = generate_environment_key().unwrap();
        assert_ne!(v1.as_bytes(), v2.as_bytes());
        let w1 = wrap_environment_key(&manager, &manager.public_key(), &ENV, 1, &v1).unwrap();
        assert!(unwrap_environment_key(&manager, &manager.public_key(), &ENV, 2, &w1).is_err());
    }
}

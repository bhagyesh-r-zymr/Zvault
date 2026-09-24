//! Team access to environments.
//!
//! Every environment has its own random 256-bit key, and secrets in it are
//! sealed under that key. Giving someone access means *wrapping* the key to
//! their X25519 sharing key with the same sender-authenticated box used for
//! user shares ([`crate::seal_to`]), under separate labels so a wrapped
//! environment key can never be passed off as a share, or the reverse.
//!
//! Members get the project key (it seals names and other metadata) and the
//! key of each environment they may hold. The associated data is the
//! project module's key AAD ([`crate::project::aad`]), plus the key version
//! for environments, so the server cannot move a wrap to another environment
//! or roll someone back to a key version they were removed from. Groups have
//! no keys of their own: a group grant is carried out by wrapping to each
//! member.
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

use crate::project::aad;
use crate::share::{open_box, seal_box};
use crate::{BoxedShare, Error, KEY_LEN, PUBLIC_KEY_LEN, Result, SharingKeyPair, SymmetricKey};

/// Access request ids are UUIDs: 16 bytes.
pub const ACCESS_ID_LEN: usize = 16;

const WRAP_INFO: &[u8] = b"zvault/v1/member-key-wrap";
const RELEASE_INFO: &[u8] = b"zvault/v1/access-release";
const RELEASE_AAD_PREFIX: &[u8] = b"zvault/v1/access-release:";

/// Associated data for an environment key wrapped to a member: the
/// environment's key AAD plus the key version, so an old version's wrap can't
/// be replayed after a rotation.
pub fn environment_key_wrap_aad(
    project_id: &str,
    environment_id: &str,
    key_version: u32,
) -> Vec<u8> {
    let mut out = aad::environment_key(project_id, environment_id);
    out.extend_from_slice(format!("|v{key_version}").as_bytes());
    out
}

/// Associated data for the project key wrapped to a member.
pub fn project_key_wrap_aad(project_id: &str) -> Vec<u8> {
    aad::project_key(project_id)
}

/// A fresh key for the next environment key version on rotation.
pub fn generate_environment_key() -> Result<SymmetricKey> {
    SymmetricKey::generate()
}

/// Wraps a project or environment `key` from a manager to one member. `aad`
/// is [`environment_key_wrap_aad`] or [`project_key_wrap_aad`].
pub fn wrap_key_to_member(
    wrapper: &SharingKeyPair,
    recipient_public: &[u8; PUBLIC_KEY_LEN],
    aad: &[u8],
    key: &SymmetricKey,
) -> Result<BoxedShare> {
    seal_box(WRAP_INFO, aad, wrapper, recipient_public, key.as_bytes())
}

/// Unwraps a key. Fails unless the holder of `wrapper_public` wrapped it to
/// `recipient` under exactly this `aad`.
pub fn unwrap_key_from_member(
    recipient: &SharingKeyPair,
    wrapper_public: &[u8; PUBLIC_KEY_LEN],
    aad: &[u8],
    wrapped: &BoxedShare,
) -> Result<SymmetricKey> {
    let bytes = Zeroizing::new(open_box(
        WRAP_INFO,
        aad,
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

    const P: &str = "0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d";
    const DEV: &str = "1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e";
    const PROD: &str = "2d7c6e5a-7f3b-4c4d-8e9f-8a7b6c5d4e3f";

    #[test]
    fn wrapped_key_round_trips_to_a_member() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let aad = environment_key_wrap_aad(P, DEV, 1);
        let wrapped = wrap_key_to_member(&manager, &member.public_key(), &aad, &key).unwrap();
        let unwrapped =
            unwrap_key_from_member(&member, &manager.public_key(), &aad, &wrapped).unwrap();
        assert_eq!(unwrapped.as_bytes(), key.as_bytes());
    }

    #[test]
    fn wrap_is_bound_to_environment_version_wrapper_and_recipient() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let mallory = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let aad = environment_key_wrap_aad(P, DEV, 2);
        let wrapped = wrap_key_to_member(&manager, &member.public_key(), &aad, &key).unwrap();

        let m = manager.public_key();
        for result in [
            // Moved to another environment, or passed off as the project key.
            unwrap_key_from_member(&member, &m, &environment_key_wrap_aad(P, PROD, 2), &wrapped),
            unwrap_key_from_member(&member, &m, &project_key_wrap_aad(P), &wrapped),
            // Replayed as a different key version.
            unwrap_key_from_member(&member, &m, &environment_key_wrap_aad(P, DEV, 1), &wrapped),
            // The server claims someone else wrapped it.
            unwrap_key_from_member(&member, &mallory.public_key(), &aad, &wrapped),
            // Someone else tries to open it.
            unwrap_key_from_member(&mallory, &m, &aad, &wrapped),
        ] {
            assert!(matches!(result, Err(Error::Decrypt)));
        }
    }

    #[test]
    fn wraps_and_shares_cannot_be_confused() {
        let manager = SharingKeyPair::generate().unwrap();
        let member = SharingKeyPair::generate().unwrap();
        let key = generate_environment_key().unwrap();
        let share_id = [0xE1; SHARE_ID_LEN];
        let aad = [b"zvault/v1/share-box:".as_slice(), &share_id].concat();
        let wrapped = wrap_key_to_member(&manager, &member.public_key(), &aad, &key).unwrap();
        assert_eq!(
            open_from(&member, &manager.public_key(), &share_id, &wrapped),
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
}

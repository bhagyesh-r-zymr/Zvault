//! Team access commands: handing project and environment keys to org
//! members, rotating an environment's key after someone loses access, and
//! releasing values for approved "Needs approval" requests.
//!
//! Keys are wrapped from this account's sharing key pair (derived from the
//! keyset, like [`crate::sharing`]) to each member's published sharing key.
//! The UI fetches who needs a key from the access API, calls these commands,
//! and posts the returned bodies unchanged:
//!
//! - [`project_key_wrap`] → `POST /v1/access/projects/:id/keys`
//! - [`environment_key_wrap`] → `POST /v1/access/environments/:id/keys`
//! - [`environment_rotate`] → `POST /v1/access/environments/:id/rotate`,
//!   then [`environment_rotate_commit`] once the API accepted it
//! - [`access_release_seal`] → `POST /v1/access/requests/:id/approve`
//!
//! Members open what was shared with them by passing their wrap from
//! `GET /v1/access/projects/:id/keys/me` to `project_open` and
//! `environment_open`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;
use zvault_crypto::project::aad;
use zvault_crypto::vault::{open_padded, seal_padded};
use zvault_crypto::{
    ACCESS_ID_LEN, BoxedShare, PUBLIC_KEY_LEN, SharingKeyPair, SymmetricKey,
    environment_key_wrap_aad, generate_environment_key, open_release, project_key_wrap_aad,
    seal_release, unwrap_key_from_member, wrap_key_to_member,
};

use crate::projects::ValuePlaintext;
use crate::vault::{Blob, Keyring, VaultError, canonical_id};

type Result<T> = core::result::Result<T, VaultError>;

/// `kid` of a key wrapped to a member. Matches `MEMBER_KEY_WRAP_KID` in `@zvault/shared`.
pub(crate) const MEMBER_KEY_WRAP_KID: &str = "member-key-wrap";
/// `kid` of values released for an approved request (`ACCESS_RELEASE_KID`).
const ACCESS_RELEASE_KID: &str = "access-release";
/// Matches `ACCESS_LIMITS` / `ApproveAccessRequest` in `@zvault/shared`.
const MAX_RELEASE_BYTES: usize = 64 * 1024;

fn decode_key(s: &str) -> Result<[u8; PUBLIC_KEY_LEN]> {
    B64.decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(VaultError::InvalidRecord)
}

fn request_id_bytes(id: &str) -> Result<[u8; ACCESS_ID_LEN]> {
    Ok(*Uuid::parse_str(&canonical_id(id)?)
        .map_err(|_| VaultError::InvalidRecord)?
        .as_bytes())
}

fn pair_of(account: &SymmetricKey) -> SharingKeyPair {
    // The keyring's account key is the keyset key the sharing pair is
    // derived from, so this matches the key published to the org.
    SharingKeyPair::derive_from_keyset(account)
}

/// A member to wrap a key to: `PendingWrap` in `@zvault/shared`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipient {
    pub account_id: String,
    pub public_key: String,
}

/// `MemberKeyWrap` in `@zvault/shared`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberKeyWrap {
    pub recipient_id: String,
    pub recipient_public_key: String,
    pub wrapper_public_key: String,
    pub ephemeral_public_key: String,
    pub blob: Blob,
}

/// `StoredMemberWrap` in `@zvault/shared`: one of the caller's own wraps.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMemberWrap {
    #[serde(flatten)]
    pub wrap: MemberKeyWrap,
    /// Environment keys only.
    #[serde(default)]
    pub key_version: Option<u32>,
}

impl StoredMemberWrap {
    fn unwrap(&self, account: &SymmetricKey, aad: &[u8]) -> Result<SymmetricKey> {
        let me = pair_of(account);
        if decode_key(&self.wrap.recipient_public_key)? != me.public_key() {
            // Wrapped to a key this account no longer has.
            return Err(VaultError::Decrypt);
        }
        let boxed = BoxedShare {
            ephemeral_public: decode_key(&self.wrap.ephemeral_public_key)?,
            sealed: self.wrap.blob.sealed(MEMBER_KEY_WRAP_KID)?,
        };
        unwrap_key_from_member(
            &me,
            &decode_key(&self.wrap.wrapper_public_key)?,
            aad,
            &boxed,
        )
        .map_err(|_| VaultError::Decrypt)
    }

    pub(crate) fn unwrap_project_key(
        &self,
        account: &SymmetricKey,
        project_id: &str,
    ) -> Result<SymmetricKey> {
        self.unwrap(account, &project_key_wrap_aad(project_id))
    }

    pub(crate) fn unwrap_environment_key(
        &self,
        account: &SymmetricKey,
        project_id: &str,
        environment_id: &str,
    ) -> Result<SymmetricKey> {
        let version = self.key_version.ok_or(VaultError::InvalidRecord)?;
        self.unwrap(
            account,
            &environment_key_wrap_aad(project_id, environment_id, version),
        )
    }
}

fn wrap_to(
    me: &SharingKeyPair,
    recipients: &[Recipient],
    aad: &[u8],
    key: &SymmetricKey,
) -> Result<Vec<MemberKeyWrap>> {
    let wrapper_public_key = B64.encode(me.public_key());
    recipients
        .iter()
        .map(|r| {
            let boxed = wrap_key_to_member(me, &decode_key(&r.public_key)?, aad, key)
                .map_err(|_| VaultError::Encrypt)?;
            Ok(MemberKeyWrap {
                recipient_id: canonical_id(&r.account_id)?,
                recipient_public_key: r.public_key.clone(),
                wrapper_public_key: wrapper_public_key.clone(),
                ephemeral_public_key: B64.encode(boxed.ephemeral_public),
                blob: Blob::new(MEMBER_KEY_WRAP_KID, &boxed.sealed),
            })
        })
        .collect()
}

/// The body of `POST /v1/access/projects/:id/keys`.
#[derive(Debug, Serialize)]
pub struct AddProjectWraps {
    pub wraps: Vec<MemberKeyWrap>,
}

/// The body of `POST /v1/access/environments/:id/keys`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddEnvironmentWraps {
    pub key_version: u32,
    pub wraps: Vec<MemberKeyWrap>,
}

/// One secret's value in an environment, as the projects API returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValueCipher {
    pub secret_id: String,
    pub encrypted_value: Blob,
}

/// The body of `POST /v1/access/environments/:id/rotate`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateEnvironmentKey {
    pub from_version: u32,
    pub wraps: Vec<MemberKeyWrap>,
    pub values: Vec<SecretValueCipher>,
}

/// The body of `POST /v1/access/requests/:id/approve`, and the `release` the
/// requester gets back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRelease {
    pub approver_public_key: String,
    pub ephemeral_public_key: String,
    pub blob: Blob,
}

/// A value the approver releases: which secret, in which environment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseItem {
    /// The reference the requester asked for, echoed back to them.
    pub item: String,
    pub secret_id: String,
    pub environment_id: String,
    pub encrypted_value: Blob,
}

/// A released value as the requester sees it.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReleasedValue {
    pub item: String,
    pub value: String,
}

impl Drop for ReleasedValue {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.value);
    }
}

fn open_value(
    key: &SymmetricKey,
    project_id: &str,
    secret_id: &str,
    environment_id: &str,
    blob: &Blob,
) -> Result<ValuePlaintext> {
    let json = open_padded(
        key,
        &blob.sealed(environment_id)?,
        &aad::secret_value(project_id, secret_id, environment_id),
    )
    .map_err(|_| VaultError::Decrypt)?;
    serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)
}

fn seal_value(
    key: &SymmetricKey,
    project_id: &str,
    secret_id: &str,
    environment_id: &str,
    value: &ValuePlaintext,
) -> Result<Blob> {
    let json = Zeroizing::new(serde_json::to_vec(value).map_err(|_| VaultError::Encrypt)?);
    let sealed = seal_padded(
        key,
        &json,
        &aad::secret_value(project_id, secret_id, environment_id),
    )
    .map_err(|_| VaultError::Encrypt)?;
    Ok(Blob::new(environment_id, &sealed))
}

impl Keyring {
    /// Wraps an open project's key to members who don't have it yet.
    pub fn wrap_project_key(
        &self,
        project_id: &str,
        recipients: &[Recipient],
    ) -> Result<AddProjectWraps> {
        let project_id = canonical_id(project_id)?;
        self.with_project_keys(|account, keys| {
            let wraps = wrap_to(
                &pair_of(account),
                recipients,
                &project_key_wrap_aad(&project_id),
                keys.project(&project_id)?,
            )?;
            Ok(AddProjectWraps { wraps })
        })
    }

    /// Wraps an unlocked environment's current key (version `key_version`) to
    /// members who don't have it yet.
    pub fn wrap_environment_key(
        &self,
        project_id: &str,
        environment_id: &str,
        key_version: u32,
        recipients: &[Recipient],
    ) -> Result<AddEnvironmentWraps> {
        let project_id = canonical_id(project_id)?;
        let environment_id = canonical_id(environment_id)?;
        self.with_project_keys(|account, keys| {
            let wraps = wrap_to(
                &pair_of(account),
                recipients,
                &environment_key_wrap_aad(&project_id, &environment_id, key_version),
                keys.environment(&project_id, &environment_id)?,
            )?;
            Ok(AddEnvironmentWraps { key_version, wraps })
        })
    }

    /// Moves an environment to a fresh key: re-seals every value under it and
    /// wraps it to everyone who keeps access (`recipients`, this account
    /// included). The new key is only used once [`Self::commit_rotation`]
    /// confirms the API took it.
    pub fn rotate_environment(
        &self,
        project_id: &str,
        environment_id: &str,
        from_version: u32,
        recipients: &[Recipient],
        values: &[SecretValueCipher],
    ) -> Result<RotateEnvironmentKey> {
        let project_id = canonical_id(project_id)?;
        let environment_id = canonical_id(environment_id)?;
        let to_version = from_version
            .checked_add(1)
            .ok_or(VaultError::InvalidRecord)?;
        self.with_project_keys(|account, keys| {
            let current = keys.environment(&project_id, &environment_id)?;
            let next = generate_environment_key().map_err(|_| VaultError::Encrypt)?;
            let values = values
                .iter()
                .map(|v| {
                    let secret_id = canonical_id(&v.secret_id)?;
                    let plain = open_value(
                        current,
                        &project_id,
                        &secret_id,
                        &environment_id,
                        &v.encrypted_value,
                    )?;
                    Ok(SecretValueCipher {
                        encrypted_value: seal_value(
                            &next,
                            &project_id,
                            &secret_id,
                            &environment_id,
                            &plain,
                        )?,
                        secret_id,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let wraps = wrap_to(
                &pair_of(account),
                recipients,
                &environment_key_wrap_aad(&project_id, &environment_id, to_version),
                &next,
            )?;
            keys.rotations.insert((project_id, environment_id), next);
            Ok(RotateEnvironmentKey {
                from_version,
                wraps,
                values,
            })
        })
    }

    /// Switches to the key made by [`Self::rotate_environment`] after the API
    /// accepted the rotation. Returns false if there was none pending.
    pub fn commit_rotation(&self, project_id: &str, environment_id: &str) -> Result<bool> {
        let id = (canonical_id(project_id)?, canonical_id(environment_id)?);
        self.with_project_keys(|_, keys| {
            Ok(match keys.rotations.remove(&id) {
                Some(next) => {
                    keys.environments.insert(id, next);
                    true
                }
                None => false,
            })
        })
    }

    /// Decrypts the values an approved request asked for and seals them to the
    /// requester, bound to the request id.
    pub fn seal_access_release(
        &self,
        project_id: &str,
        request_id: &str,
        requester_public_key: &str,
        items: &[ReleaseItem],
    ) -> Result<AccessRelease> {
        let project_id = canonical_id(project_id)?;
        let request = request_id_bytes(request_id)?;
        let requester = decode_key(requester_public_key)?;
        self.with_project_keys(|account, keys| {
            let released = items
                .iter()
                .map(|i| {
                    let env_id = canonical_id(&i.environment_id)?;
                    let secret_id = canonical_id(&i.secret_id)?;
                    let mut plain = open_value(
                        keys.environment(&project_id, &env_id)?,
                        &project_id,
                        &secret_id,
                        &env_id,
                        &i.encrypted_value,
                    )?;
                    Ok(ReleasedValue {
                        item: i.item.clone(),
                        value: std::mem::take(&mut plain.value),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let json =
                Zeroizing::new(serde_json::to_vec(&released).map_err(|_| VaultError::Encrypt)?);
            if json.len() > MAX_RELEASE_BYTES {
                return Err(VaultError::InvalidRecord);
            }
            let me = pair_of(account);
            let boxed =
                seal_release(&me, &requester, &request, &json).map_err(|_| VaultError::Encrypt)?;
            Ok(AccessRelease {
                approver_public_key: B64.encode(me.public_key()),
                ephemeral_public_key: B64.encode(boxed.ephemeral_public),
                blob: Blob::new(ACCESS_RELEASE_KID, &boxed.sealed),
            })
        })
    }

    /// Opens values released to this account for `request_id`.
    pub fn open_access_release(
        &self,
        request_id: &str,
        release: &AccessRelease,
    ) -> Result<Vec<ReleasedValue>> {
        let request = request_id_bytes(request_id)?;
        self.with_project_keys(|account, _| {
            let boxed = BoxedShare {
                ephemeral_public: decode_key(&release.ephemeral_public_key)?,
                sealed: release.blob.sealed(ACCESS_RELEASE_KID)?,
            };
            let json = Zeroizing::new(
                open_release(
                    &pair_of(account),
                    &decode_key(&release.approver_public_key)?,
                    &request,
                    &boxed,
                )
                .map_err(|_| VaultError::Decrypt)?,
            );
            serde_json::from_slice(&json).map_err(|_| VaultError::Decrypt)
        })
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn project_key_wrap(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    recipients: Vec<Recipient>,
) -> Result<AddProjectWraps> {
    keyring.wrap_project_key(&project_id, &recipients)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn environment_key_wrap(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    environment_id: String,
    key_version: u32,
    recipients: Vec<Recipient>,
) -> Result<AddEnvironmentWraps> {
    keyring.wrap_environment_key(&project_id, &environment_id, key_version, &recipients)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn environment_rotate(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    environment_id: String,
    from_version: u32,
    recipients: Vec<Recipient>,
    values: Vec<SecretValueCipher>,
) -> Result<RotateEnvironmentKey> {
    keyring.rotate_environment(
        &project_id,
        &environment_id,
        from_version,
        &recipients,
        &values,
    )
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn environment_rotate_commit(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    environment_id: String,
) -> Result<bool> {
    keyring.commit_rotation(&project_id, &environment_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn access_release_seal(
    keyring: tauri::State<'_, Keyring>,
    project_id: String,
    request_id: String,
    requester_public_key: String,
    items: Vec<ReleaseItem>,
) -> Result<AccessRelease> {
    keyring.seal_access_release(&project_id, &request_id, &requester_public_key, &items)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn access_release_open(
    keyring: tauri::State<'_, Keyring>,
    request_id: String,
    release: AccessRelease,
) -> Result<Vec<ReleasedValue>> {
    keyring.open_access_release(&request_id, &release)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::projects::{EnvironmentCipher, NewProject, ProjectCipher};

    struct Person {
        keyring: Keyring,
        public_key: String,
        id: String,
    }

    fn person() -> Person {
        let keyset = SymmetricKey::generate().unwrap();
        let public_key = B64.encode(SharingKeyPair::derive_from_keyset(&keyset).public_key());
        let keyring = Keyring::default();
        keyring.unlock(keyset);
        Person {
            keyring,
            public_key,
            id: Uuid::new_v4().to_string(),
        }
    }

    fn recipient(p: &Person) -> Recipient {
        Recipient {
            account_id: p.id.clone(),
            public_key: p.public_key.clone(),
        }
    }

    fn stored(wrap: &MemberKeyWrap, key_version: Option<u32>) -> StoredMemberWrap {
        // Round-trip through JSON the way the API serves it.
        let mut v = serde_json::to_value(wrap).unwrap();
        v["keyVersion"] = json!(key_version);
        v["wrappedBy"] = json!(Uuid::new_v4().to_string());
        serde_json::from_value(v).unwrap()
    }

    fn project(owner: &Person) -> NewProject {
        owner
            .keyring
            .create_project(
                &json!({ "name": "Payments API", "slug": "payments-api" }),
                &[json!({ "name": "Production", "slug": "production", "kind": "production", "position": 0 })],
            )
            .unwrap()
    }

    fn cipher(p: &NewProject) -> ProjectCipher {
        ProjectCipher {
            id: p.id.clone(),
            encrypted_key: p.encrypted_key.clone(),
            encrypted_meta: p.encrypted_meta.clone(),
        }
    }

    /// The environment as the API serves it to a member: their wrap's blob.
    fn served(env: &EnvironmentCipher, wrap: &MemberKeyWrap) -> EnvironmentCipher {
        EnvironmentCipher {
            encrypted_key: Some(wrap.blob.clone()),
            ..env.clone()
        }
    }

    #[test]
    fn a_member_opens_a_shared_project_and_its_values() {
        let (owner, member) = (person(), person());
        let p = project(&owner);
        let env = &p.environments[0];
        let secret = Uuid::new_v4().to_string();
        let value = owner
            .keyring
            .seal_secret_value(&p.id, &secret, &env.id, "sk_live_1".into())
            .unwrap();

        let pw = owner
            .keyring
            .wrap_project_key(&p.id, &[recipient(&member)])
            .unwrap();
        let ew = owner
            .keyring
            .wrap_environment_key(&p.id, &env.id, 1, &[recipient(&member)])
            .unwrap();
        assert_eq!(pw.wraps[0].blob.kid, MEMBER_KEY_WRAP_KID);
        assert_eq!(ew.wraps[0].recipient_id, member.id);

        let mut shared = cipher(&p);
        shared.encrypted_key = pw.wraps[0].blob.clone();
        let meta = member
            .keyring
            .open_project(&shared, Some(&stored(&pw.wraps[0], None)))
            .unwrap();
        assert_eq!(meta["name"], "Payments API");

        // Without the public halves the environment shows as locked.
        let locked = member
            .keyring
            .open_environment(&p.id, &served(env, &ew.wraps[0]), None)
            .unwrap();
        assert!(!locked.unlocked);

        let view = member
            .keyring
            .open_environment(
                &p.id,
                &served(env, &ew.wraps[0]),
                Some(&stored(&ew.wraps[0], Some(1))),
            )
            .unwrap();
        assert!(view.unlocked);
        assert_eq!(
            member
                .keyring
                .open_secret_value(&p.id, &secret, &env.id, &value)
                .unwrap()
                .as_str(),
            "sk_live_1"
        );
    }

    #[test]
    fn wraps_are_bound_to_recipient_resource_and_version() {
        let (owner, member, outsider) = (person(), person(), person());
        let p = project(&owner);
        let env = &p.environments[0];
        let ew = owner
            .keyring
            .wrap_environment_key(&p.id, &env.id, 1, &[recipient(&member)])
            .unwrap();
        let w = &ew.wraps[0];
        owner
            .keyring
            .wrap_project_key(&p.id, &[recipient(&member)])
            .unwrap();

        // Someone else can't use it.
        assert!(
            stored(w, Some(1))
                .unwrap_environment_key(&account_of(&outsider), &p.id, &env.id)
                .is_err()
        );
        let account = account_of(&member);
        // Replayed as another version, environment, or as the project key.
        assert!(
            stored(w, Some(2))
                .unwrap_environment_key(&account, &p.id, &env.id)
                .is_err()
        );
        let other = Uuid::new_v4().to_string();
        assert!(
            stored(w, Some(1))
                .unwrap_environment_key(&account, &p.id, &other)
                .is_err()
        );
        assert!(stored(w, None).unwrap_project_key(&account, &p.id).is_err());
        assert!(
            stored(w, Some(1))
                .unwrap_environment_key(&account, &p.id, &env.id)
                .is_ok()
        );
    }

    /// The keyset a test person's keyring was unlocked with.
    fn account_of(p: &Person) -> SymmetricKey {
        p.keyring
            .with_project_keys(|account, _| Ok(SymmetricKey::from_bytes(*account.as_bytes())))
            .unwrap()
    }

    #[test]
    fn rotation_reseals_values_and_only_remaining_members_get_the_new_key() {
        let (owner, stays) = (person(), person());
        let p = project(&owner);
        let env = &p.environments[0];
        // All someone who leaves could have kept.
        let old_key = owner
            .keyring
            .with_project_keys(|_, keys| {
                Ok(SymmetricKey::from_bytes(
                    *keys.environment(&p.id, &env.id)?.as_bytes(),
                ))
            })
            .unwrap();
        let secret = Uuid::new_v4().to_string();
        let old = owner
            .keyring
            .seal_secret_value(&p.id, &secret, &env.id, "db-pass".into())
            .unwrap();
        let body = owner
            .keyring
            .rotate_environment(
                &p.id,
                &env.id,
                1,
                &[
                    Recipient {
                        account_id: owner.id.clone(),
                        public_key: owner.public_key.clone(),
                    },
                    recipient(&stays),
                ],
                &[SecretValueCipher {
                    secret_id: secret.clone(),
                    encrypted_value: old.clone(),
                }],
            )
            .unwrap();
        assert_eq!(body.from_version, 1);
        assert_eq!(body.wraps.len(), 2);
        let new_value = &body.values[0].encrypted_value;
        assert_ne!(new_value, &old);

        // Until committed, the old key stays in use.
        assert!(
            owner
                .keyring
                .open_secret_value(&p.id, &secret, &env.id, new_value)
                .is_err()
        );
        assert!(owner.keyring.commit_rotation(&p.id, &env.id).unwrap());
        assert!(!owner.keyring.commit_rotation(&p.id, &env.id).unwrap());
        assert_eq!(
            owner
                .keyring
                .open_secret_value(&p.id, &secret, &env.id, new_value)
                .unwrap()
                .as_str(),
            "db-pass"
        );

        // The member who stays opens v2 and the re-sealed value.
        let key = stored(&body.wraps[1], Some(2))
            .unwrap_environment_key(&account_of(&stays), &p.id, &env.id)
            .unwrap();
        assert!(open_value(&key, &p.id, &secret, &env.id, new_value).is_ok());
        assert!(open_value(&old_key, &p.id, &secret, &env.id, new_value).is_err());
    }

    #[test]
    fn approved_values_reach_only_the_requester() {
        let (manager, requester, outsider) = (person(), person(), person());
        let p = project(&manager);
        let env = &p.environments[0];
        let secret = Uuid::new_v4().to_string();
        let value = manager
            .keyring
            .seal_secret_value(&p.id, &secret, &env.id, "ghp_123".into())
            .unwrap();
        let request = Uuid::new_v4().to_string();
        let items = [ReleaseItem {
            item: "zv://payments-api/production/github/token".into(),
            secret_id: secret,
            environment_id: env.id.clone(),
            encrypted_value: value,
        }];
        let release = manager
            .keyring
            .seal_access_release(&p.id, &request, &requester.public_key, &items)
            .unwrap();
        assert_eq!(release.blob.kid, ACCESS_RELEASE_KID);

        let opened = requester
            .keyring
            .open_access_release(&request, &release)
            .unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].item, "zv://payments-api/production/github/token");
        assert_eq!(opened[0].value, "ghp_123");

        assert!(
            outsider
                .keyring
                .open_access_release(&request, &release)
                .is_err()
        );
        let other = Uuid::new_v4().to_string();
        assert!(
            requester
                .keyring
                .open_access_release(&other, &release)
                .is_err()
        );
    }
}

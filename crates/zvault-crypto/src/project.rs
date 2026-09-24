//! Project, environment and secret encryption.
//!
//! ```text
//! account key ──wraps──► project key ──seals──► project, environment, folder and secret metadata
//!             └─wraps──► environment key ──seals──► that environment's secret values
//! ```
//!
//! Each project and each environment has its own random key. Environment keys
//! are wrapped for each member separately (not under the project key), so a
//! member can hold the Development key without ever seeing Production's.
//! Metadata and values are padded with [`seal_padded`](crate::vault::seal_padded)
//! so ciphertext length reveals only a coarse size bucket.
//!
//! Every ciphertext is bound by its associated data to the project and record
//! it belongs to, so the server cannot move a value to another secret or
//! environment, or swap metadata between records, without decryption failing.

/// Associated data for each kind of ciphertext. Ids are the client-generated
/// UUIDs the server stores the records under.
pub mod aad {
    /// The project key, wrapped for a member.
    pub fn project_key(project_id: &str) -> Vec<u8> {
        format!("zvault/v1/project-key|{project_id}").into_bytes()
    }

    /// Project name, slug and description, sealed with the project key.
    pub fn project_meta(project_id: &str) -> Vec<u8> {
        format!("zvault/v1/project-meta|{project_id}").into_bytes()
    }

    /// An environment key, wrapped for a member.
    pub fn environment_key(project_id: &str, environment_id: &str) -> Vec<u8> {
        format!("zvault/v1/environment-key|{project_id}|{environment_id}").into_bytes()
    }

    /// Environment name, slug and settings, sealed with the project key.
    pub fn environment_meta(project_id: &str, environment_id: &str) -> Vec<u8> {
        format!("zvault/v1/environment-meta|{project_id}|{environment_id}").into_bytes()
    }

    /// Folder name, sealed with the project key.
    pub fn folder_meta(project_id: &str, folder_id: &str) -> Vec<u8> {
        format!("zvault/v1/folder-meta|{project_id}|{folder_id}").into_bytes()
    }

    /// Secret name, variable name, folder and tags, sealed with the project key.
    pub fn secret_meta(project_id: &str, secret_id: &str) -> Vec<u8> {
        format!("zvault/v1/secret-meta|{project_id}|{secret_id}").into_bytes()
    }

    /// A secret's value in one environment, sealed with that environment's key.
    pub fn secret_value(project_id: &str, secret_id: &str, environment_id: &str) -> Vec<u8> {
        format!("zvault/v1/secret-value|{project_id}|{secret_id}|{environment_id}").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::aad;
    use crate::SymmetricKey;
    use crate::vault::{open_padded, seal_padded, unwrap_key, wrap_key};

    const P: &str = "8d1b6f1e-0000-4000-8000-000000000001";
    const S: &str = "8d1b6f1e-0000-4000-8000-0000000000aa";
    const DEV: &str = "8d1b6f1e-0000-4000-8000-0000000000d1";
    const PROD: &str = "8d1b6f1e-0000-4000-8000-0000000000d3";

    #[test]
    fn a_value_is_bound_to_its_secret_and_environment() {
        let env = SymmetricKey::generate().unwrap();
        let sealed = seal_padded(&env, b"sk_live_123", &aad::secret_value(P, S, PROD)).unwrap();
        assert_eq!(
            open_padded(&env, &sealed, &aad::secret_value(P, S, PROD))
                .unwrap()
                .as_slice(),
            b"sk_live_123"
        );
        // Relabelled as Development, or moved to another secret or project.
        assert!(open_padded(&env, &sealed, &aad::secret_value(P, S, DEV)).is_err());
        assert!(open_padded(&env, &sealed, &aad::secret_value(P, DEV, PROD)).is_err());
        assert!(open_padded(&env, &sealed, &aad::secret_value(DEV, S, PROD)).is_err());
    }

    #[test]
    fn environment_keys_are_bound_to_their_environment() {
        let account = SymmetricKey::generate().unwrap();
        let prod = SymmetricKey::generate().unwrap();
        let wrapped = wrap_key(&account, &prod, &aad::environment_key(P, PROD)).unwrap();
        assert!(unwrap_key(&account, &wrapped, &aad::environment_key(P, DEV)).is_err());
        assert!(unwrap_key(&account, &wrapped, &aad::project_key(P)).is_err());
        let back = unwrap_key(&account, &wrapped, &aad::environment_key(P, PROD)).unwrap();
        assert_eq!(back.as_bytes(), prod.as_bytes());
    }

    #[test]
    fn metadata_kinds_are_not_interchangeable() {
        let project = SymmetricKey::generate().unwrap();
        let sealed = seal_padded(&project, b"{}", &aad::secret_meta(P, S)).unwrap();
        assert!(open_padded(&project, &sealed, &aad::folder_meta(P, S)).is_err());
        assert!(open_padded(&project, &sealed, &aad::environment_meta(P, S)).is_err());
        assert!(open_padded(&project, &sealed, &aad::secret_meta(P, S)).is_ok());
    }

    #[test]
    fn project_and_environment_keys_are_independent() {
        // Holding the project key never yields an environment key.
        let account = SymmetricKey::generate().unwrap();
        let project = SymmetricKey::generate().unwrap();
        let env = SymmetricKey::generate().unwrap();
        let wrapped = wrap_key(&account, &env, &aad::environment_key(P, DEV)).unwrap();
        assert!(unwrap_key(&project, &wrapped, &aad::environment_key(P, DEV)).is_err());
    }
}

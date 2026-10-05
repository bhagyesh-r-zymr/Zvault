//! Secret sync: pushes one environment's secrets from the user's device to
//! GitHub Actions secrets or AWS Secrets Manager.
//!
//! Values are decrypted on the device (in the Mac app's Rust core) and go
//! straight to the provider over TLS, so the Zvault server never sees them
//! and zero-knowledge holds. Provider credentials stay on the device too.
//!
//! - [`github`]: repository or GitHub environment secrets, each value sealed
//!   to the repository's public key (libsodium sealed box) before upload.
//! - [`aws`]: one Secrets Manager secret per environment holding every
//!   variable as a JSON object, signed with AWS Signature Version 4.

pub mod aws;
pub mod github;
mod target;

pub use target::{Target, TargetError};

use serde::Serialize;
use zeroize::Zeroizing;

/// Longest a provider takes to answer one request.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// One variable to push: its name and the decrypted value.
pub struct Item {
    pub name: String,
    pub value: Zeroizing<String>,
}

/// What one push did. Names only, never values.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Variables written.
    pub pushed: Vec<String>,
    /// Variables deleted because they are no longer in the environment.
    pub removed: Vec<String>,
    /// Variables that could not be written, with why.
    pub failed: Vec<Failure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Target(#[from] TargetError),
    #[error("could not reach {0}: check the connection and try again")]
    Network(&'static str),
    #[error("{provider} refused the credentials ({status}); connect it again with a new one")]
    Unauthorized { provider: &'static str, status: u16 },
    #[error("{0}")]
    Provider(String),
}

impl Error {
    fn network(provider: &'static str) -> impl FnOnce(reqwest::Error) -> Self {
        move |_| Self::Network(provider)
    }
}

/// Credentials for a provider, as kept in the device's keychain.
#[derive(Clone, serde::Deserialize, serde::Serialize, zeroize::ZeroizeOnDrop)]
#[serde(
    tag = "provider",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Credential {
    /// A fine-grained personal access token with "Secrets: read and write"
    /// (and "Environments: read and write" for environment secrets).
    Github { token: String },
    Aws {
        access_key_id: String,
        secret_access_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_token: Option<String>,
    },
}

impl core::fmt::Debug for Credential {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Github { .. } => "Credential::Github(..)",
            Self::Aws { .. } => "Credential::Aws(..)",
        })
    }
}

/// Pushes `items` to `target`. `previous` are the names an earlier push to
/// the same target wrote; for GitHub, those no longer in `items` are deleted.
/// AWS keeps the whole environment in one secret, so it needs no deletes.
pub async fn push(
    target: &Target,
    credential: &Credential,
    items: &[Item],
    previous: &[String],
) -> Result<Report, Error> {
    target.validate()?;
    match (target, credential) {
        (
            Target::Github {
                repo, environment, ..
            },
            Credential::Github { token },
        ) => {
            github::Client::new(token)
                .push(repo, environment.as_deref(), items, previous)
                .await
        }
        (
            Target::Aws {
                region,
                secret_name,
                ..
            },
            Credential::Aws { .. },
        ) => {
            aws::Client::new(credential, region)?
                .put_environment(secret_name, items)
                .await
        }
        (Target::Github { .. }, _) => Err(Error::Provider("connect GitHub first".into())),
        (Target::Aws { .. }, _) => Err(Error::Provider("connect AWS first".into())),
    }
}

/// Checks a credential with the provider and returns who it belongs to: the
/// GitHub login, or the AWS identity's ARN.
pub async fn verify(credential: &Credential) -> Result<String, Error> {
    match credential {
        Credential::Github { token } => github::Client::new(token).whoami().await,
        Credential::Aws { .. } => aws::Client::new(credential, "us-east-1")?.whoami().await,
    }
}

fn http() -> reqwest::Client {
    // Fails harmlessly when another part of the app installed one first.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("Zvault secret sync")
        .build()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github() -> Target {
        Target::Github {
            id: "t1".into(),
            repo: "acme/web".into(),
            environment: None,
        }
    }

    fn aws_target() -> Target {
        Target::Aws {
            id: "t2".into(),
            region: "ap-south-1".into(),
            secret_name: "web/prod".into(),
        }
    }

    fn aws_credential() -> Credential {
        Credential::Aws {
            access_key_id: "AKIAEXAMPLE".into(),
            secret_access_key: "secret".into(),
            session_token: None,
        }
    }

    fn github_credential() -> Credential {
        Credential::Github {
            token: "ghp_example".into(),
        }
    }

    #[tokio::test]
    async fn push_needs_a_valid_target() {
        let bad = Target::Github {
            id: "t".into(),
            repo: "nope".into(),
            environment: None,
        };
        let err = push(&bad, &github_credential(), &[], &[])
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Target(TargetError::Repo)));
        assert!(err.to_string().contains("owner/name"));
    }

    #[tokio::test]
    async fn push_asks_for_the_matching_provider() {
        let err = push(&github(), &aws_credential(), &[], &[])
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "connect GitHub first");
        let err = push(&aws_target(), &github_credential(), &[], &[])
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "connect AWS first");
    }

    #[test]
    fn credentials_never_print_their_secrets() {
        assert_eq!(
            format!("{:?}", github_credential()),
            "Credential::Github(..)"
        );
        assert_eq!(format!("{:?}", aws_credential()), "Credential::Aws(..)");
    }

    #[test]
    fn credentials_round_trip_with_camel_case_fields() {
        let json = serde_json::to_value(aws_credential()).unwrap();
        assert_eq!(json["provider"], "aws");
        assert_eq!(json["accessKeyId"], "AKIAEXAMPLE");
        assert!(json.get("sessionToken").is_none());
        let back: Credential = serde_json::from_value(json).unwrap();
        assert!(matches!(back, Credential::Aws { .. }));

        let gh: Credential =
            serde_json::from_str(r#"{"provider":"github","token":"ghp_x"}"#).unwrap();
        assert!(matches!(gh, Credential::Github { ref token } if token == "ghp_x"));
    }

    #[test]
    fn reports_serialize_names_only() {
        let report = Report {
            pushed: vec!["A".into()],
            removed: vec!["B".into()],
            failed: vec![Failure {
                name: "C".into(),
                reason: "too long".into(),
            }],
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["pushed"][0], "A");
        assert_eq!(json["failed"][0]["reason"], "too long");
        assert_eq!(Report::default(), Report::default());
    }

    #[test]
    fn error_messages_tell_people_what_to_do() {
        assert!(Error::Network("GitHub").to_string().contains("GitHub"));
        let unauthorized = Error::Unauthorized {
            provider: "AWS",
            status: 403,
        };
        assert!(unauthorized.to_string().contains("403"));
    }

    #[tokio::test]
    async fn network_errors_hide_the_cause() {
        let err = reqwest::Client::new()
            .get("http://127.0.0.1:1")
            .send()
            .await
            .unwrap_err();
        let mapped = Error::network("GitHub")(err);
        assert!(matches!(mapped, Error::Network("GitHub")));
    }
}

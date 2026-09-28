//! Where an environment syncs to. Matches `SyncTarget` in `@zvault/shared`,
//! where targets live inside the environment's encrypted metadata.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "provider",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Target {
    /// GitHub Actions secrets of a repository, or of one of its environments.
    Github {
        id: String,
        /// `owner/name`.
        repo: String,
        /// A GitHub deployment environment; repository secrets without one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        environment: Option<String>,
    },
    /// One AWS Secrets Manager secret holding the environment as JSON.
    Aws {
        id: String,
        region: String,
        /// Created on the first push if it doesn't exist.
        secret_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TargetError {
    #[error("name the repository as owner/name, for example acme/payments-api")]
    Repo,
    #[error("the GitHub environment name is not valid")]
    GithubEnvironment,
    #[error("the AWS region is not valid, for example ap-south-1")]
    Region,
    #[error(
        "the AWS secret name may use letters, digits and /_+=.@- (up to 512), for example payments-api/production"
    )]
    SecretName,
}

impl Target {
    pub fn validate(&self) -> Result<(), TargetError> {
        match self {
            Self::Github {
                repo, environment, ..
            } => {
                let ok_part = |s: &str| {
                    !s.is_empty()
                        && s.len() <= 100
                        && s != "."
                        && s != ".."
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                };
                match repo.split_once('/') {
                    Some((owner, name)) if ok_part(owner) && ok_part(name) => {}
                    _ => return Err(TargetError::Repo),
                }
                if let Some(env) = environment {
                    let n = env.chars().count();
                    if n == 0
                        || n > 255
                        || env.contains(['/', '\\', '?', '#', '%'])
                        || env.chars().any(char::is_control)
                    {
                        return Err(TargetError::GithubEnvironment);
                    }
                }
                Ok(())
            }
            Self::Aws {
                region,
                secret_name,
                ..
            } => {
                let parts: Vec<&str> = region.split('-').collect();
                if parts.len() < 3
                    || parts.iter().any(|p| {
                        p.is_empty()
                            || !p
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                    })
                    || region.len() > 32
                {
                    return Err(TargetError::Region);
                }
                if secret_name.is_empty()
                    || secret_name.len() > 512
                    || !secret_name.bytes().all(|b| {
                        b.is_ascii_alphanumeric()
                            || matches!(b, b'/' | b'_' | b'+' | b'=' | b'.' | b'@' | b'-')
                    })
                {
                    return Err(TargetError::SecretName);
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(repo: &str, environment: Option<&str>) -> Target {
        Target::Github {
            id: "t1".into(),
            repo: repo.into(),
            environment: environment.map(Into::into),
        }
    }

    fn aws(region: &str, name: &str) -> Target {
        Target::Aws {
            id: "t2".into(),
            region: region.into(),
            secret_name: name.into(),
        }
    }

    #[test]
    fn validates_github_targets() {
        assert!(gh("acme/payments-api", None).validate().is_ok());
        assert!(gh("acme/web.site", Some("production")).validate().is_ok());
        for bad in ["acme", "/x", "acme/", "a/b/c", "acme/..", "acme/pay ments"] {
            assert_eq!(gh(bad, None).validate(), Err(TargetError::Repo), "{bad}");
        }
        assert_eq!(
            gh("acme/web", Some("a/b")).validate(),
            Err(TargetError::GithubEnvironment)
        );
    }

    #[test]
    fn validates_aws_targets() {
        assert!(
            aws("ap-south-1", "payments-api/production")
                .validate()
                .is_ok()
        );
        assert!(aws("us-gov-west-1", "x").validate().is_ok());
        assert_eq!(aws("mars", "x").validate(), Err(TargetError::Region));
        assert_eq!(
            aws("us-east-1", "a b").validate(),
            Err(TargetError::SecretName)
        );
    }

    #[test]
    fn reads_the_shape_the_app_stores() {
        let t: Target = serde_json::from_str(
            r#"{"id":"a","provider":"aws","region":"ap-south-1","secretName":"web/prod"}"#,
        )
        .unwrap();
        assert_eq!(t, aws("ap-south-1", "web/prod").with_id("a"));
        let t: Target =
            serde_json::from_str(r#"{"id":"t1","provider":"github","repo":"acme/web"}"#).unwrap();
        assert_eq!(t, gh("acme/web", None));
    }

    impl Target {
        fn with_id(mut self, new: &str) -> Self {
            match &mut self {
                Self::Github { id, .. } | Self::Aws { id, .. } => *id = new.into(),
            }
            self
        }
    }
}

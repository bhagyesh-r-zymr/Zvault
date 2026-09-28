//! GitHub Actions secrets.
//!
//! GitHub only accepts values encrypted to the repository's (or
//! environment's) public key with a libsodium sealed box, so each value is
//! sealed here before it leaves the device.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use crypto_box::PublicKey;
use crypto_box::aead::OsRng;
use serde::Deserialize;
use serde_json::json;

use crate::{Error, Failure, Item, Report};

const API: &str = "https://api.github.com";
const PROVIDER: &str = "GitHub";
/// GitHub's limit on one secret.
const MAX_VALUE: usize = 48 * 1024;

/// Seals `value` to a base64 X25519 public key the way GitHub expects
/// (`crypto_box_seal`), returning base64 ciphertext.
pub fn seal(public_key_b64: &str, value: &[u8]) -> Result<String, Error> {
    let bad = || Error::Provider("GitHub sent a public key Zvault can't use".into());
    let raw: [u8; 32] = B64
        .decode(public_key_b64.trim())
        .map_err(|_| bad())?
        .try_into()
        .map_err(|_| bad())?;
    let sealed = PublicKey::from(raw)
        .seal(&mut OsRng, value)
        .map_err(|_| bad())?;
    Ok(B64.encode(sealed))
}

/// Why GitHub won't take a secret by this name, if it won't.
pub fn name_problem(name: &str) -> Option<&'static str> {
    let mut bytes = name.bytes();
    if !bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Some("GitHub secret names use only letters, digits and _");
    }
    if name.to_ascii_uppercase().starts_with("GITHUB_") {
        return Some("GitHub reserves names starting with GITHUB_");
    }
    None
}

#[derive(Deserialize)]
struct RepoKey {
    key_id: String,
    key: String,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Client {
    pub fn new(token: &str) -> Self {
        Self::with_base(token, API)
    }

    /// For tests: talks to `base` instead of api.github.com.
    pub fn with_base(token: &str, base: &str) -> Self {
        Self {
            http: crate::http(),
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
        }
    }

    fn url(&self, repo: &str, environment: Option<&str>, tail: &[&str]) -> reqwest::Url {
        let mut url = reqwest::Url::parse(&self.base).expect("base URL is valid");
        {
            let mut path = url.path_segments_mut().expect("base URL has a path");
            path.push("repos");
            path.extend(repo.split('/'));
            if let Some(env) = environment {
                path.push("environments");
                path.push(env);
            }
            path.push("secrets");
            path.extend(tail);
        }
        url
    }

    fn request(&self, method: reqwest::Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    /// The login the token belongs to.
    pub async fn whoami(&self) -> Result<String, Error> {
        let url = reqwest::Url::parse(&format!("{}/user", self.base)).expect("valid URL");
        let res = self
            .request(reqwest::Method::GET, url)
            .send()
            .await
            .map_err(Error::network(PROVIDER))?;
        let res = check(res, "the token").await?;
        let user: User = res.json().await.map_err(Error::network(PROVIDER))?;
        Ok(user.login)
    }

    /// Writes every item, then deletes names in `previous` that are gone.
    pub async fn push(
        &self,
        repo: &str,
        environment: Option<&str>,
        items: &[Item],
        previous: &[String],
    ) -> Result<Report, Error> {
        let what = match environment {
            Some(env) => format!("{repo} (environment {env})"),
            None => repo.to_owned(),
        };
        let res = self
            .request(
                reqwest::Method::GET,
                self.url(repo, environment, &["public-key"]),
            )
            .send()
            .await
            .map_err(Error::network(PROVIDER))?;
        let res = check(res, &what).await?;
        let key: RepoKey = res.json().await.map_err(Error::network(PROVIDER))?;

        let mut report = Report::default();
        for item in items {
            if let Some(why) = name_problem(&item.name) {
                report.failed.push(Failure {
                    name: item.name.clone(),
                    reason: why.into(),
                });
                continue;
            }
            if item.value.len() > MAX_VALUE {
                report.failed.push(Failure {
                    name: item.name.clone(),
                    reason: "GitHub secrets are limited to 48 KB".into(),
                });
                continue;
            }
            let sealed = seal(&key.key, item.value.as_bytes())?;
            let res = self
                .request(
                    reqwest::Method::PUT,
                    self.url(repo, environment, &[&item.name]),
                )
                .json(&json!({ "encrypted_value": sealed, "key_id": key.key_id }))
                .send()
                .await
                .map_err(Error::network(PROVIDER))?;
            match check(res, &what).await {
                Ok(_) => report.pushed.push(item.name.clone()),
                Err(e @ (Error::Unauthorized { .. } | Error::Network(_))) => return Err(e),
                Err(e) => report.failed.push(Failure {
                    name: item.name.clone(),
                    reason: e.to_string(),
                }),
            }
        }

        let current = |n: &str| items.iter().any(|i| i.name.eq_ignore_ascii_case(n));
        for name in previous.iter().filter(|n| !current(n)) {
            if name_problem(name).is_some() {
                continue;
            }
            let res = self
                .request(
                    reqwest::Method::DELETE,
                    self.url(repo, environment, &[name]),
                )
                .send()
                .await
                .map_err(Error::network(PROVIDER))?;
            // Already gone counts as removed.
            if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
                report.removed.push(name.clone());
            } else {
                let e = check(res, &what).await.err();
                report.failed.push(Failure {
                    name: name.clone(),
                    reason: e.map_or_else(|| "not deleted".into(), |e| e.to_string()),
                });
            }
        }
        Ok(report)
    }
}

/// Turns an error status into an [`Error`] a person can act on.
async fn check(res: reqwest::Response, what: &str) -> Result<reqwest::Response, Error> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let message = res
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("message")?.as_str().map(str::to_owned))
        .unwrap_or_default();
    Err(match status.as_u16() {
        401 => Error::Unauthorized {
            provider: PROVIDER,
            status: 401,
        },
        403 => Error::Provider(format!(
            "GitHub refused access to {what}: the token needs Secrets read and write on it{}",
            if message.is_empty() {
                String::new()
            } else {
                format!(" ({message})")
            }
        )),
        404 => Error::Provider(format!("GitHub found no {what}, or the token can't see it")),
        code => Error::Provider(format!("GitHub answered {code} for {what}: {message}")),
    })
}

#[cfg(test)]
mod tests {
    use crypto_box::SecretKey;

    use super::*;

    #[test]
    fn seals_so_the_repository_key_opens_it() {
        let secret = SecretKey::generate(&mut OsRng);
        let public = B64.encode(secret.public_key().as_bytes());
        let sealed = B64.decode(seal(&public, b"s3cret").unwrap()).unwrap();
        // 32-byte ephemeral key + 16-byte tag + message.
        assert_eq!(sealed.len(), 32 + 16 + 6);
        assert_eq!(secret.unseal(&sealed).unwrap(), b"s3cret");
        assert!(seal("not base64!", b"x").is_err());
        assert!(seal(&B64.encode([1u8; 16]), b"x").is_err());
    }

    #[test]
    fn knows_what_names_github_takes() {
        assert_eq!(name_problem("DATABASE_URL"), None);
        assert_eq!(name_problem("_x1"), None);
        assert!(name_problem("GITHUB_TOKEN").is_some());
        assert!(name_problem("github_x").is_some());
        assert!(name_problem("1A").is_some());
        assert!(name_problem("").is_some());
    }

    #[test]
    fn builds_repository_and_environment_urls() {
        let c = Client::with_base("t", "https://api.example.test");
        assert_eq!(
            c.url("acme/web", None, &["public-key"]).as_str(),
            "https://api.example.test/repos/acme/web/secrets/public-key"
        );
        assert_eq!(
            c.url("acme/web", Some("prod eu"), &["API_KEY"]).as_str(),
            "https://api.example.test/repos/acme/web/environments/prod%20eu/secrets/API_KEY"
        );
    }
}

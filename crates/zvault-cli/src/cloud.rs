//! `ZVAULT_TOKEN`: reading secrets without the Zvault app, for CI and cloud
//! agents.
//!
//! A token (made in Zvault > project > Access > Tokens) is itself the key:
//! `zv` proves it to the API with a key derived from it, gets back the
//! project's ciphertext and the project and environment keys wrapped for the
//! token, and decrypts here. The API never sees the token secret. A token
//! reads one environment of one project (falling back to the environments it
//! inherits from) and cannot change anything.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;
use zvault_agent::{ScopePattern, SecretRef};
use zvault_crypto::project::aad;
use zvault_crypto::vault::open_padded;
use zvault_crypto::{AgentToken, NONCE_LEN, Sealed, SymmetricKey};

/// The token, from Zvault > project > Access > Tokens.
pub const TOKEN_ENV: &str = "ZVAULT_TOKEN";
/// The Zvault server, when it isn't the one this zv was built for.
pub const SERVER_ENV: &str = "ZVAULT_SERVER";
const DEFAULT_SERVER: &str = match option_env!("ZVAULT_API_URL") {
    Some(url) => url,
    None => "https://52-66-189-120.sslip.io",
};
const TOKEN_KID: &str = "agent-token";
const PAGE: u32 = 500;

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("{TOKEN_ENV} is not a Zvault token (it starts with zvt_)")]
    BadToken,
    #[error("{SERVER_ENV} must be an https:// URL")]
    BadServer,
    #[error("could not reach Zvault at {0}: {1}")]
    Unreachable(String, String),
    #[error("{0}")]
    Rejected(String),
    #[error("{0}")]
    OutOfScope(String),
    #[error("the Zvault server sent something unexpected ({0})")]
    Unexpected(String),
    #[error("could not decrypt what the server sent; the token or the data is wrong")]
    Decrypt,
}

impl CloudError {
    /// Same meanings as the app's: 2 unreachable, 3 not authorized, 4 out of scope.
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Unreachable(..) => 2,
            Self::Rejected(_) => 3,
            Self::OutOfScope(_) => 4,
            Self::BadToken | Self::BadServer => 64,
            Self::Unexpected(_) | Self::Decrypt => 1,
        }
    }
}

type Result<T> = core::result::Result<T, CloudError>;

/// The token from the environment, if one is set.
pub fn token_from_env() -> Option<Zeroizing<String>> {
    std::env::var(TOKEN_ENV)
        .ok()
        .map(Zeroizing::new)
        .filter(|t| !t.trim().is_empty())
}

// ---------------------------------------------------------------- wire

#[derive(Deserialize)]
struct Blob {
    v: u32,
    alg: String,
    kid: String,
    nonce: String,
    ct: String,
}

impl Blob {
    fn sealed(&self, kid: &str) -> Result<Sealed> {
        if self.v != 1 || self.alg != "xchacha20poly1305" || self.kid != kid {
            return Err(CloudError::Decrypt);
        }
        let nonce: [u8; NONCE_LEN] = B64
            .decode(&self.nonce)
            .ok()
            .and_then(|n| n.try_into().ok())
            .ok_or(CloudError::Decrypt)?;
        let ciphertext = B64.decode(&self.ct).map_err(|_| CloudError::Decrypt)?;
        Ok(Sealed { nonce, ciphertext })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    token: SessionToken,
    project: SessionProject,
    environments: Vec<SessionEnvironment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionToken {
    name: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionProject {
    id: String,
    encrypted_meta: Blob,
    encrypted_key: Blob,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEnvironment {
    environment_id: String,
    key_version: u32,
    encrypted_key: Blob,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    deleted: bool,
    encrypted_meta: Option<Blob>,
    #[serde(default)]
    values: Vec<EntryValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryValue {
    environment_id: String,
    encrypted_value: Blob,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    entries: Vec<Entry>,
    cursor: u64,
    has_more: bool,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

// ---------------------------------------------------------------- snapshot

/// One secret the token can read, with its value in each of its environments.
struct Secret {
    folder: Option<String>,
    key: String,
    /// Environment id → sealed value.
    values: HashMap<String, Sealed>,
    id: String,
}

/// What a token opens, decrypted except for the values.
pub struct Snapshot {
    pub token_name: String,
    pub expires_at: String,
    project_id: String,
    project_slug: String,
    /// The token's environments, nearest first: (id, slug, key).
    environments: Vec<(String, String, SymmetricKey)>,
    secrets: Vec<Secret>,
}

impl Snapshot {
    /// Unwraps the token's keys and opens every name the token can see.
    pub fn open(token: &AgentToken, session: Session, entries: Vec<Entry>) -> Result<Self> {
        let project_id = session.project.id;
        let project_key = token
            .unwrap_project_key(
                &project_id,
                &session.project.encrypted_key.sealed(TOKEN_KID)?,
            )
            .map_err(|_| CloudError::Decrypt)?;
        let project_meta = open_json(
            &project_key,
            &session.project.encrypted_meta,
            &project_id,
            &aad::project_meta(&project_id),
        )?;

        let live: Vec<&Entry> = entries.iter().filter(|e| !e.deleted).collect();
        let meta_of = |kind: &str, id: &str, aad: Vec<u8>| -> Result<Option<Value>> {
            live.iter()
                .find(|e| e.kind == kind && e.id == id)
                .and_then(|e| e.encrypted_meta.as_ref())
                .map(|b| open_json(&project_key, b, id, &aad))
                .transpose()
        };

        let mut environments = Vec::with_capacity(session.environments.len());
        for env in session.environments {
            let id = env.environment_id;
            let key = token
                .unwrap_environment_key(
                    &project_id,
                    &id,
                    env.key_version,
                    &env.encrypted_key.sealed(TOKEN_KID)?,
                )
                .map_err(|_| CloudError::Decrypt)?;
            let meta = meta_of("environment", &id, aad::environment_meta(&project_id, &id))?
                .ok_or_else(|| {
                    CloudError::Rejected("the token's environment was deleted".into())
                })?;
            environments.push((id, slug_of(&meta)?, key));
        }
        if environments.is_empty() {
            return Err(CloudError::Unexpected(
                "a token without environments".into(),
            ));
        }

        let mut folders = HashMap::new();
        for e in live.iter().filter(|e| e.kind == "folder") {
            if let Some(meta) = meta_of("folder", &e.id, aad::folder_meta(&project_id, &e.id))? {
                folders.insert(e.id.clone(), slug_of(&meta)?);
            }
        }

        let mut secrets = Vec::new();
        for e in live.iter().filter(|e| e.kind == "secret") {
            let Some(meta) = meta_of("secret", &e.id, aad::secret_meta(&project_id, &e.id))? else {
                continue;
            };
            let key = meta["key"].as_str().ok_or(CloudError::Decrypt)?.to_owned();
            let folder = match meta["folderId"].as_str() {
                // A secret in a folder that no longer exists shows at the top.
                Some(id) => folders.get(id).cloned(),
                None => None,
            };
            let mut values = HashMap::new();
            for v in &e.values {
                values.insert(
                    v.environment_id.clone(),
                    v.encrypted_value.sealed(&v.environment_id)?,
                );
            }
            secrets.push(Secret {
                folder,
                key,
                values,
                id: e.id.clone(),
            });
        }

        Ok(Self {
            token_name: session.token.name,
            expires_at: session.token.expires_at,
            project_slug: slug_of(&project_meta)?,
            project_id,
            environments,
            secrets,
        })
    }

    /// The place this token reads: `zv://project/environment`.
    pub fn place(&self) -> String {
        format!("zv://{}/{}", self.project_slug, self.environments[0].1)
    }

    fn reference(&self, s: &Secret) -> SecretRef {
        SecretRef {
            project: self.project_slug.clone(),
            environment: self.environments[0].1.clone(),
            folder: s.folder.clone(),
            key: s.key.clone(),
        }
    }

    /// Where a secret's value comes from: the token's environment, else the
    /// nearest one it inherits from.
    fn source<'a>(
        &'a self,
        s: &'a Secret,
    ) -> Option<(&'a (String, String, SymmetricKey), &'a Sealed)> {
        self.environments
            .iter()
            .find_map(|env| s.values.get(&env.0).map(|v| (env, v)))
    }

    /// Every secret path the token can read, sorted.
    pub fn refs(&self) -> Vec<SecretRef> {
        let mut out: Vec<SecretRef> = self
            .secrets
            .iter()
            .filter(|s| self.source(s).is_some())
            .map(|s| self.reference(s))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    fn check_scope(&self, place: &str, r: &[&str]) -> Result<()> {
        let inside = r.first().is_none_or(|p| *p == self.project_slug)
            && r.get(1).is_none_or(|e| *e == self.environments[0].1);
        if inside {
            Ok(())
        } else {
            Err(CloudError::OutOfScope(format!(
                "{place} is outside this token, which reads {}",
                self.place()
            )))
        }
    }

    /// One secret's value.
    pub fn read(&self, r: &SecretRef) -> Result<Zeroizing<String>> {
        self.check_scope(&r.to_string(), &r.places())?;
        let secret = self
            .secrets
            .iter()
            .find(|s| s.key == r.key && s.folder == r.folder && self.source(s).is_some())
            .ok_or_else(|| CloudError::OutOfScope(format!("{r} does not exist or has no value")))?;
        self.open_value(secret)
    }

    /// Every secret under `prefix`, as (path, value).
    pub fn export(&self, prefix: &ScopePattern) -> Result<Vec<(SecretRef, Zeroizing<String>)>> {
        match prefix {
            ScopePattern::Exact(r) => Ok(vec![(r.clone(), self.read(r)?)]),
            ScopePattern::Prefix(p) => {
                let places: Vec<&str> = p.iter().map(String::as_str).collect();
                self.check_scope(&prefix.to_string(), &places)?;
                let mut out = Vec::new();
                for s in &self.secrets {
                    let r = self.reference(s);
                    if self.source(s).is_some() && prefix.allows(&r) {
                        out.push((r, self.open_value(s)?));
                    }
                }
                out.sort_by(|a, b| a.0.cmp(&b.0));
                Ok(out)
            }
        }
    }

    fn open_value(&self, s: &Secret) -> Result<Zeroizing<String>> {
        let ((env_id, _, key), sealed) = self.source(s).ok_or(CloudError::Decrypt)?;
        let json = open_padded(
            key,
            sealed,
            &aad::secret_value(&self.project_id, &s.id, env_id),
        )
        .map_err(|_| CloudError::Decrypt)?;
        #[derive(Deserialize)]
        struct Plain {
            value: Zeroizing<String>,
        }
        let plain: Plain = serde_json::from_slice(&json).map_err(|_| CloudError::Decrypt)?;
        Ok(plain.value)
    }
}

fn open_json(key: &SymmetricKey, blob: &Blob, kid: &str, aad: &[u8]) -> Result<Value> {
    let json = open_padded(key, &blob.sealed(kid)?, aad).map_err(|_| CloudError::Decrypt)?;
    serde_json::from_slice(&json).map_err(|_| CloudError::Decrypt)
}

fn slug_of(meta: &Value) -> Result<String> {
    meta["slug"]
        .as_str()
        .map(str::to_owned)
        .ok_or(CloudError::Decrypt)
}

// ---------------------------------------------------------------- http

/// Fetches and opens everything the token in `raw` can read.
pub fn load(raw: &str) -> Result<Snapshot> {
    let token = AgentToken::decode(raw).map_err(|_| CloudError::BadToken)?;
    let server = std::env::var(SERVER_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_owned());
    let server = server.trim_end_matches('/');
    let local = server.starts_with("http://localhost") || server.starts_with("http://127.0.0.1");
    if !server.starts_with("https://") && !local {
        return Err(CloudError::BadServer);
    }
    let auth = Zeroizing::new(format!(
        "Authorization: Bearer {}.{}",
        token.id_string(),
        B64.encode(token.auth_key().as_ref())
    ));

    let session: Session = parse(&get(server, "/v1/token", &auth)?)?;
    let mut entries = Vec::new();
    let mut since = 0;
    loop {
        let page: Changes = parse(&get(
            server,
            &format!("/v1/token/changes?since={since}&limit={PAGE}"),
            &auth,
        )?)?;
        entries.extend(page.entries);
        if !page.has_more || page.cursor <= since {
            break;
        }
        since = page.cursor;
    }
    Snapshot::open(&token, session, entries)
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T> {
    serde_json::from_slice(body).map_err(|e| CloudError::Unexpected(e.to_string()))
}

/// GETs `path`. The Authorization header goes to curl on stdin, so it never
/// shows up in the process list.
fn get(server: &str, path: &str, auth_header: &str) -> Result<Vec<u8>> {
    let url = format!("{server}{path}");
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "--proto",
            "=https,http",
            "--tlsv1.2",
            "--max-time",
            "60",
            "-H",
            "@-",
            "-H",
            "Accept: application/json",
            "-w",
            "\n%{http_code}",
        ])
        .arg(&url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CloudError::Unreachable(server.into(), format!("curl: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(auth_header.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    let out = child
        .wait_with_output()
        .map_err(|e| CloudError::Unreachable(server.into(), e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(CloudError::Unreachable(server.into(), err));
    }
    let text = out.stdout;
    let split = text.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    let status: u16 = String::from_utf8_lossy(&text[split..])
        .trim()
        .parse()
        .unwrap_or(0);
    let body = text[..split].to_vec();
    match status {
        200 => Ok(body),
        401 | 409 => {
            let code = serde_json::from_slice::<ErrorBody>(&body)
                .ok()
                .and_then(|b| b.error)
                .unwrap_or_default();
            Err(CloudError::Rejected(rejection(&code).into()))
        }
        429 => Err(CloudError::Unreachable(
            server.into(),
            "too many requests; try again in a minute".into(),
        )),
        s => Err(CloudError::Unexpected(format!("HTTP {s}"))),
    }
}

fn rejection(code: &str) -> &'static str {
    match code {
        "token_expired" => "this token has expired; make a new one in Zvault",
        "token_stale" => "this token's environment key was rotated; re-issue the token in Zvault",
        "token_creator_lost_access" => {
            "the person who made this token no longer has access; make a new one in Zvault"
        }
        "token_environment_deleted" => "the token's environment was deleted",
        _ => "this token is not valid (revoked, or mistyped)",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zvault_crypto::vault::seal_padded;

    use super::*;

    const P: &str = "0b9a4c3e-5f1d-4a2b-8c7d-6e5f4a3b2c1d";
    const DEV: &str = "1c8b5d4f-6e2a-4b3c-9d8e-7f6a5b4c3d2e";
    const STAGING: &str = "2d7c6e5a-7f3b-4c4d-8e9f-8a7b6c5d4e3f";
    const PROD: &str = "3e8d7f6b-8a4c-4d5e-9fa0-9b8c7d6e5f40";
    const FOLDER: &str = "4f9e8a7c-9b5d-4e6f-a0b1-ac9d8e7f6051";

    fn blob(kid: &str, sealed: &Sealed) -> Value {
        json!({ "v": 1, "alg": "xchacha20poly1305", "kid": kid,
                "nonce": B64.encode(sealed.nonce), "ct": B64.encode(&sealed.ciphertext) })
    }

    fn meta(key: &SymmetricKey, kid: &str, aad: &[u8], v: Value) -> Value {
        blob(
            kid,
            &seal_padded(key, v.to_string().as_bytes(), aad).unwrap(),
        )
    }

    struct World {
        token: AgentToken,
        session: Value,
        entries: Value,
    }

    /// A project "web" with Development, Staging (inherits Development) and
    /// Production, and a token for Staging.
    fn world() -> World {
        let token = AgentToken::generate().unwrap();
        let project = SymmetricKey::generate().unwrap();
        let keys: HashMap<&str, SymmetricKey> = [DEV, STAGING, PROD]
            .into_iter()
            .map(|e| (e, SymmetricKey::generate().unwrap()))
            .collect();
        let env = |id: &str, slug: &str| {
            json!({ "id": id, "type": "environment", "deleted": false,
                    "encryptedMeta": meta(&project, id, &aad::environment_meta(P, id), json!({ "slug": slug })) })
        };
        let value = |secret: &str, env: &str, v: &str| {
            json!({ "environmentId": env,
                    "encryptedValue": meta(&keys[env], env, &aad::secret_value(P, secret, env), json!({ "value": v })) })
        };
        let secret = |id: &str, key: &str, folder: Option<&str>, values: Vec<Value>| {
            json!({ "id": id, "type": "secret", "deleted": false, "values": values,
                    "encryptedMeta": meta(&project, id, &aad::secret_meta(P, id),
                        json!({ "name": key, "key": key, "folderId": folder, "tags": [] })) })
        };
        const S1: &str = "5a0f9b8d-0c6e-4f70-b1c2-bd0e9f807162";
        const S2: &str = "6b1a0c9e-1d7f-4a81-82d3-ce1f0a918273";
        const S3: &str = "7c2b1d0f-2e80-4b92-93e4-df201ba29384";
        let token_envs: Vec<Value> = [STAGING, DEV]
            .iter()
            .map(|e| {
                let wrapped = token.wrap_environment_key(P, e, 1, &keys[e]).unwrap();
                json!({ "environmentId": e, "keyVersion": 1, "encryptedKey": blob("agent-token", &wrapped) })
            })
            .collect();
        let session = json!({
            "token": { "id": token.id_string(), "name": "CI", "expiresAt": "2027-01-01T00:00:00.000Z" },
            "project": {
                "id": P,
                "encryptedMeta": meta(&project, P, &aad::project_meta(P), json!({ "name": "Web", "slug": "web" })),
                "encryptedKey": blob("agent-token", &token.wrap_project_key(P, &project).unwrap()),
            },
            "environments": token_envs,
        });
        let entries = json!([
            env(DEV, "development"),
            env(STAGING, "staging"),
            env(PROD, "production"),
            { "id": FOLDER, "type": "folder", "deleted": false,
              "encryptedMeta": meta(&project, FOLDER, &aad::folder_meta(P, FOLDER), json!({ "name": "Stripe", "slug": "stripe" })) },
            secret(S1, "DATABASE_URL", None, vec![value(S1, DEV, "postgres://dev"), value(S1, STAGING, "postgres://staging")]),
            secret(S2, "STRIPE_KEY", Some(FOLDER), vec![value(S2, DEV, "sk_test")]),
            secret(S3, "ONLY_PROD", None, vec![]),
        ]);
        World {
            token,
            session,
            entries,
        }
    }

    fn open(w: World) -> Snapshot {
        Snapshot::open(
            &w.token,
            serde_json::from_value(w.session).unwrap(),
            serde_json::from_value(w.entries).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn reads_its_environment_and_falls_back_to_what_it_inherits() {
        let snap = open(world());
        assert_eq!(snap.place(), "zv://web/staging");
        let refs: Vec<String> = snap.refs().iter().map(ToString::to_string).collect();
        assert_eq!(
            refs,
            [
                "zv://web/staging/DATABASE_URL",
                "zv://web/staging/stripe/STRIPE_KEY"
            ]
        );
        let read = |s: &str| snap.read(&s.parse().unwrap()).map(|v| v.to_string());
        assert_eq!(
            read("zv://web/staging/DATABASE_URL").unwrap(),
            "postgres://staging"
        );
        assert_eq!(
            read("zv://web/staging/stripe/STRIPE_KEY").unwrap(),
            "sk_test"
        );
        let all = snap.export(&"zv://web/staging/*".parse().unwrap()).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn refuses_everything_outside_the_token() {
        let snap = open(world());
        for outside in [
            "zv://web/production/DATABASE_URL",
            "zv://web/development/DATABASE_URL",
            "zv://api/staging/DATABASE_URL",
            "zv://web/staging/ONLY_PROD",
            "zv://web/staging/MISSING",
        ] {
            assert!(matches!(
                snap.read(&outside.parse().unwrap()),
                Err(CloudError::OutOfScope(_))
            ));
        }
        assert!(
            snap.export(&"zv://web/production/*".parse().unwrap())
                .is_err()
        );
    }

    #[test]
    fn another_token_cannot_open_the_wraps() {
        let mut w = world();
        w.token = AgentToken::generate().unwrap();
        let result = Snapshot::open(
            &w.token,
            serde_json::from_value(w.session).unwrap(),
            serde_json::from_value(w.entries).unwrap(),
        );
        assert!(matches!(result, Err(CloudError::Decrypt)));
    }
}

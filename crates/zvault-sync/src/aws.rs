//! AWS Secrets Manager, called directly over HTTPS with Signature Version 4.
//!
//! An environment becomes one secret whose value is a JSON object of its
//! variables (`{"DATABASE_URL": "…", …}`), the shape ECS, Lambda and the
//! AWS SDKs read with a JSON key. Each push replaces the whole object.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{Credential, Error, Item, Report};

const PROVIDER: &str = "AWS";
/// Secrets Manager's limit on one secret value.
const MAX_VALUE: usize = 64 * 1024;

type HmacSha256 = Hmac<Sha256>;

/// Access keys for signing. The secret is wiped on drop.
pub struct Keys {
    pub access_key_id: String,
    pub secret_access_key: Zeroizing<String>,
    pub session_token: Option<String>,
}

/// One request to sign. `headers` must include `host`; names in lowercase.
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: &'a [u8],
}

fn hex(bytes: &[u8]) -> String {
    use core::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `YYYYMMDDTHHMMSSZ` for a Unix time, as `x-amz-date` wants it.
pub fn amz_date(unix: u64) -> String {
    let days = i64::try_from(unix / 86_400).unwrap_or(0);
    let secs = unix % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// The `Authorization` header for `req`, signed at `date` (see [`amz_date`]).
pub fn authorization(
    req: &Request<'_>,
    keys: &Keys,
    region: &str,
    service: &str,
    date: &str,
) -> String {
    let mut headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        req.method,
        req.path,
        req.query,
        hex(&Sha256::digest(req.body)),
    );
    let day = &date[..8];
    let scope = format!("{day}/{region}/{service}/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let k_secret = Zeroizing::new(format!("AWS4{}", keys.secret_access_key.as_str()));
    let k_date = hmac(k_secret.as_bytes(), day);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, service);
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        keys.access_key_id
    )
}

pub struct Client {
    http: reqwest::Client,
    keys: Keys,
    region: String,
    /// For tests: replaces `https://<service>.<region>.amazonaws.com`.
    endpoint: Option<String>,
}

impl Client {
    pub fn new(credential: &Credential, region: &str) -> Result<Self, Error> {
        let Credential::Aws {
            access_key_id,
            secret_access_key,
            session_token,
        } = credential
        else {
            return Err(Error::Provider("connect AWS first".into()));
        };
        Ok(Self {
            http: crate::http(),
            keys: Keys {
                access_key_id: access_key_id.trim().to_owned(),
                secret_access_key: Zeroizing::new(secret_access_key.trim().to_owned()),
                session_token: session_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned),
            },
            region: region.to_owned(),
            endpoint: None,
        })
    }

    #[must_use]
    pub fn with_endpoint(mut self, endpoint: &str) -> Self {
        self.endpoint = Some(endpoint.trim_end_matches('/').to_owned());
        self
    }

    async fn call(
        &self,
        service: &str,
        content_type: &str,
        target: Option<&str>,
        body: &[u8],
    ) -> Result<(u16, String), Error> {
        let host = format!("{service}.{}.amazonaws.com", self.region);
        let url = match &self.endpoint {
            Some(e) => format!("{e}/"),
            None => format!("https://{host}/"),
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let date = amz_date(now);
        let mut headers = vec![
            ("content-type", content_type),
            ("host", host.as_str()),
            ("x-amz-date", date.as_str()),
        ];
        if let Some(t) = target {
            headers.push(("x-amz-target", t));
        }
        if let Some(t) = &self.keys.session_token {
            headers.push(("x-amz-security-token", t.as_str()));
        }
        let auth = authorization(
            &Request {
                method: "POST",
                path: "/",
                query: "",
                headers: &headers,
                body,
            },
            &self.keys,
            &self.region,
            service,
            &date,
        );
        let mut req = self.http.post(url).header("authorization", auth);
        for (k, v) in &headers {
            // reqwest sets Host from the URL.
            if *k != "host" {
                req = req.header(*k, *v);
            }
        }
        let res = req
            .body(body.to_vec())
            .send()
            .await
            .map_err(Error::network(PROVIDER))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(Error::network(PROVIDER))?;
        Ok((status, text))
    }

    async fn secrets_manager(&self, action: &str, body: &Value) -> Result<Value, Error> {
        let body = Zeroizing::new(serde_json::to_vec(body).expect("JSON serializes"));
        let (status, text) = self
            .call(
                "secretsmanager",
                "application/x-amz-json-1.1",
                Some(&format!("secretsmanager.{action}")),
                &body,
            )
            .await?;
        let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return Ok(json);
        }
        let kind = json
            .get("__type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let kind = kind.rsplit('#').next().unwrap_or(kind).to_owned();
        let message = json
            .get("message")
            .or_else(|| json.get("Message"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        Err(error_for(status, &kind, message))
    }

    /// Writes the environment as one JSON secret, creating it if needed.
    pub async fn put_environment(
        &self,
        secret_name: &str,
        items: &[Item],
    ) -> Result<Report, Error> {
        let mut map = Map::new();
        for item in items {
            map.insert(item.name.clone(), Value::String(item.value.to_string()));
        }
        let value = Zeroizing::new(Value::Object(map).to_string());
        if value.len() > MAX_VALUE {
            return Err(Error::Provider(
                "the environment is larger than the 64 KB a Secrets Manager secret holds".into(),
            ));
        }
        let put = self
            .secrets_manager(
                "PutSecretValue",
                &json!({
                    "SecretId": secret_name,
                    "SecretString": value.as_str(),
                    "ClientRequestToken": request_token(),
                }),
            )
            .await;
        match put {
            Ok(_) => {}
            Err(Error::Provider(m)) if m.starts_with(NOT_FOUND) => {
                self.secrets_manager(
                    "CreateSecret",
                    &json!({
                        "Name": secret_name,
                        "Description": "Synced from Zvault. Changes made here are replaced on the next sync.",
                        "SecretString": value.as_str(),
                        "ClientRequestToken": request_token(),
                    }),
                )
                .await?;
            }
            Err(e) => return Err(e),
        }
        Ok(Report {
            pushed: items.iter().map(|i| i.name.clone()).collect(),
            ..Report::default()
        })
    }

    /// The ARN of the identity the keys belong to (STS GetCallerIdentity).
    pub async fn whoami(&self) -> Result<String, Error> {
        let (status, text) = self
            .call(
                "sts",
                "application/x-www-form-urlencoded; charset=utf-8",
                None,
                b"Action=GetCallerIdentity&Version=2011-06-15",
            )
            .await?;
        let tag = |name: &str| {
            let open = format!("<{name}>");
            let start = text.find(&open)? + open.len();
            let end = text[start..].find(&format!("</{name}>"))? + start;
            Some(text[start..end].to_owned())
        };
        if (200..300).contains(&status) {
            return tag("Arn")
                .ok_or_else(|| Error::Provider("AWS sent an unexpected answer".into()));
        }
        Err(error_for(
            status,
            &tag("Code").unwrap_or_default(),
            &tag("Message").unwrap_or_default(),
        ))
    }
}

const NOT_FOUND: &str = "AWS has no secret";

fn error_for(status: u16, kind: &str, message: &str) -> Error {
    match kind {
        "ResourceNotFoundException" => Error::Provider(format!("{NOT_FOUND}: {message}")),
        "UnrecognizedClientException"
        | "InvalidClientTokenId"
        | "InvalidSignatureException"
        | "SignatureDoesNotMatch"
        | "ExpiredToken"
        | "ExpiredTokenException" => Error::Unauthorized {
            provider: PROVIDER,
            status,
        },
        "AccessDeniedException" | "AccessDenied" => Error::Provider(format!(
            "AWS denied the request; the keys need secretsmanager:PutSecretValue and secretsmanager:CreateSecret ({message})"
        )),
        "" => Error::Provider(format!("AWS answered {status}")),
        _ => Error::Provider(format!("AWS: {kind}: {message}")),
    }
}

/// An idempotency token, which raw requests must supply themselves.
fn request_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the OS has randomness");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_keys() -> Keys {
        // The example credentials from AWS's Signature Version 4 test suite.
        Keys {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: Zeroizing::new("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into()),
            session_token: None,
        }
    }

    #[test]
    fn formats_amz_dates() {
        assert_eq!(amz_date(0), "19700101T000000Z");
        assert_eq!(amz_date(1_440_938_160), "20150830T123600Z");
        assert_eq!(amz_date(1_709_210_096), "20240229T123456Z");
    }

    #[test]
    fn signs_like_the_aws_test_suite() {
        // get-vanilla from the AWS SigV4 test suite.
        let auth = authorization(
            &Request {
                method: "GET",
                path: "/",
                query: "",
                headers: &[
                    ("host", "example.amazonaws.com"),
                    ("x-amz-date", "20150830T123600Z"),
                ],
                body: b"",
            },
            &example_keys(),
            "us-east-1",
            "service",
            "20150830T123600Z",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn makes_uuid_request_tokens() {
        let t = request_token();
        assert_eq!(t.len(), 36);
        assert_eq!(&t[14..15], "4");
        assert_ne!(t, request_token());
    }

    #[test]
    fn maps_errors_to_something_to_do() {
        assert!(matches!(
            error_for(400, "UnrecognizedClientException", ""),
            Error::Unauthorized { .. }
        ));
        assert!(
            error_for(400, "AccessDeniedException", "x")
                .to_string()
                .contains("PutSecretValue")
        );
    }
}

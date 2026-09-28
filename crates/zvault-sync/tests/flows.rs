//! The request sequences sent to GitHub and AWS, against a local fake.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use crypto_box::SecretKey;
use crypto_box::aead::OsRng;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zeroize::Zeroizing;
use zvault_sync::{Credential, Item, aws, github};

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

type Answer = Box<dyn Fn(&Seen) -> (u16, String) + Send + Sync>;

/// Serves HTTP/1.1 on localhost, answering each request with `answer`.
async fn fake(answer: Answer) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let log = Arc::clone(&log);
            let answer = Arc::clone(&answer);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let head_end = loop {
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                        let mut chunk = [0u8; 4096];
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.split("\r\n");
                    let mut first = lines.next().unwrap().split(' ');
                    let method = first.next().unwrap().to_owned();
                    let path = first.next().unwrap().to_owned();
                    let headers: Vec<(String, String)> = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
                        .collect();
                    let len: usize = headers
                        .iter()
                        .find(|(k, _)| k == "content-length")
                        .map_or(0, |(_, v)| v.parse().unwrap());
                    while buf.len() < head_end + 4 + len {
                        let mut chunk = [0u8; 4096];
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body = buf[head_end + 4..head_end + 4 + len].to_vec();
                    buf.drain(..head_end + 4 + len);
                    let req = Seen {
                        method,
                        path,
                        headers,
                        body,
                    };
                    let (status, text) = answer(&req);
                    log.lock().unwrap().push(req);
                    let res = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{text}",
                        text.len()
                    );
                    if sock.write_all(res.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (base, seen)
}

fn item(name: &str, value: &str) -> Item {
    Item {
        name: name.into(),
        value: Zeroizing::new(value.into()),
    }
}

#[tokio::test]
async fn github_seals_each_value_and_removes_what_is_gone() {
    let repo_key = SecretKey::generate(&mut OsRng);
    let public = B64.encode(repo_key.public_key().as_bytes());
    let (base, seen) = fake(Box::new(move |r| {
        match (r.method.as_str(), r.path.as_str()) {
            ("GET", "/repos/acme/web/environments/production/secrets/public-key") => {
                (200, format!(r#"{{"key_id":"k1","key":"{public}"}}"#))
            }
            ("PUT", _) => (201, String::new()),
            ("DELETE", "/repos/acme/web/environments/production/secrets/OLD_ONE") => {
                (204, String::new())
            }
            _ => (404, r#"{"message":"Not Found"}"#.into()),
        }
    }))
    .await;

    let report = github::Client::with_base("ghp_test", &base)
        .push(
            "acme/web",
            Some("production"),
            &[
                item("DATABASE_URL", "postgres://x"),
                item("GITHUB_TOKEN", "nope"),
            ],
            &["OLD_ONE".into(), "DATABASE_URL".into()],
        )
        .await
        .unwrap();

    assert_eq!(report.pushed, ["DATABASE_URL"]);
    assert_eq!(report.removed, ["OLD_ONE"]);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].name, "GITHUB_TOKEN");

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    assert!(
        seen.iter()
            .all(|r| r.header("authorization") == Some("Bearer ghp_test"))
    );
    let put = &seen[1];
    assert_eq!(
        put.path,
        "/repos/acme/web/environments/production/secrets/DATABASE_URL"
    );
    let body: Value = serde_json::from_slice(&put.body).unwrap();
    assert_eq!(body["key_id"], "k1");
    let sealed = B64
        .decode(body["encrypted_value"].as_str().unwrap())
        .unwrap();
    assert_eq!(repo_key.unseal(&sealed).unwrap(), b"postgres://x");
    assert!(!String::from_utf8_lossy(&put.body).contains("postgres"));
}

#[tokio::test]
async fn github_says_when_the_token_is_refused() {
    let (base, _) = fake(Box::new(|_| {
        (401, r#"{"message":"Bad credentials"}"#.into())
    }))
    .await;
    let err = github::Client::with_base("bad", &base)
        .push("acme/web", None, &[item("A", "b")], &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("refused the credentials"), "{err}");
}

#[tokio::test]
async fn aws_creates_the_secret_when_it_does_not_exist() {
    let (base, seen) = fake(Box::new(|r| {
        match r.header("x-amz-target").unwrap_or_default() {
            "secretsmanager.PutSecretValue" => (
                400,
                r#"{"__type":"ResourceNotFoundException","message":"Secrets Manager can't find the specified secret."}"#.into(),
            ),
            "secretsmanager.CreateSecret" => (200, r#"{"ARN":"arn:x","Name":"web/prod"}"#.into()),
            _ => (400, "{}".into()),
        }
    }))
    .await;
    let cred = Credential::Aws {
        access_key_id: "AKIDEXAMPLE".into(),
        secret_access_key: "secret".into(),
        session_token: Some("session".into()),
    };
    let report = aws::Client::new(&cred, "ap-south-1")
        .unwrap()
        .with_endpoint(&base)
        .put_environment("web/prod", &[item("A", "1"), item("B", "two")])
        .await
        .unwrap();
    assert_eq!(report.pushed, ["A", "B"]);

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    let create = &seen[1];
    let auth = create.header("authorization").unwrap();
    assert!(
        auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
            && auth.contains("/ap-south-1/secretsmanager/aws4_request")
            && auth.contains(
                "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target"
            ),
        "{auth}"
    );
    assert_eq!(create.header("x-amz-security-token"), Some("session"));
    let body: Value = serde_json::from_slice(&create.body).unwrap();
    assert_eq!(body["Name"], "web/prod");
    let value: Value = serde_json::from_str(body["SecretString"].as_str().unwrap()).unwrap();
    assert_eq!(value, serde_json::json!({ "A": "1", "B": "two" }));
    assert_eq!(body["ClientRequestToken"].as_str().unwrap().len(), 36);
}

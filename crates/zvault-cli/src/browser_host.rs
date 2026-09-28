//! `zv` as the browser extension's native messaging host.
//!
//! Chrome starts `zv` with the extension's origin as its only argument and
//! talks to it over stdin and stdout in length-prefixed JSON frames. Each
//! message from the extension becomes one request to the app over the agent
//! socket, exactly like any other `zv` command; the app decides and holds
//! every key. The extension's token lives where agent tokens do (the login
//! Keychain on macOS), in its own list, so it never mixes with the agents
//! `zv --agent` can act as.
//!
//! Messages carry an `id`, which the reply repeats; requests run on their own
//! threads, so a fill does not wait behind a pairing prompt.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;
use zvault_agent::browser::{self, read_frame, write_frame};
use zvault_agent::paths;
use zvault_agent::policy::new_pairing_code;
use zvault_agent::protocol::{ErrorCode, RequestBody, Response};

use crate::client::{self, ClientError};
use crate::credentials::{self, CredError, Store};

/// The one entry in the browser's credentials file.
const CREDENTIAL_NAME: &str = "browser-extension";
const DEFAULT_NAME: &str = "Browser extension";

/// Whether Chrome started us: its first argument is the extension's origin.
pub fn started_by_browser(first_arg: Option<&str>) -> bool {
    first_arg.is_some_and(|a| a.starts_with("chrome-extension://"))
}

fn store_path() -> Result<PathBuf, CredError> {
    Ok(credentials::default_path()?.with_file_name("browser.json"))
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Message {
    /// Whether Zvault runs, is unlocked, and knows this extension.
    Status,
    /// Pairs the extension. Sends `{event: "pairingCode", code}` first.
    Pair {
        #[serde(default)]
        name: Option<String>,
    },
    /// Forgets the pairing, here and in the app.
    Unpair,
    /// Brings Zvault forward to be unlocked.
    Unlock,
    Logins {
        url: String,
        #[serde(default)]
        top_url: Option<String>,
    },
    Fill {
        item: String,
        url: String,
        #[serde(default)]
        top_url: Option<String>,
        #[serde(default)]
        otp_only: bool,
    },
    /// Whether a login typed into a page is new, changed or already saved.
    SaveCheck {
        url: String,
        #[serde(default)]
        top_url: Option<String>,
        username: String,
        password: Zeroizing<String>,
    },
    /// Saves a login typed into a page, after the user approves it in Zvault.
    Save {
        url: String,
        #[serde(default)]
        top_url: Option<String>,
        username: String,
        password: Zeroizing<String>,
        #[serde(default)]
        item: Option<String>,
    },
}

#[derive(Deserialize)]
struct Envelope {
    id: Value,
    #[serde(flatten)]
    message: Message,
}

#[derive(Debug, thiserror::Error)]
enum HostError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Cred(#[from] CredError),
    #[error("this browser is not paired with Zvault")]
    NotPaired,
}

impl HostError {
    fn code(&self) -> &'static str {
        match self {
            Self::Client(ClientError::NotRunning(_) | ClientError::NoSocketPath) => "notRunning",
            Self::Client(ClientError::App { code, .. }) => match code {
                ErrorCode::Unauthorized => "notPaired",
                ErrorCode::Locked => "locked",
                ErrorCode::Paused => "paused",
                ErrorCode::Denied => "denied",
                ErrorCode::Timeout => "timeout",
                ErrorCode::NotFound => "notFound",
                ErrorCode::WrongSite => "wrongSite",
                ErrorCode::Busy => "busy",
                _ => "error",
            },
            Self::NotPaired => "notPaired",
            _ => "error",
        }
    }
}

type Out = Arc<Mutex<std::io::Stdout>>;

fn send(out: &Out, value: &Value) {
    let json = Zeroizing::new(serde_json::to_vec(value).unwrap_or_default());
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    // A closed stdout means the browser went away; nothing to tell it.
    let _ = write_frame(&mut *out, &json);
}

/// Serves the extension until the browser closes the connection.
pub fn run(origin: &str) -> u8 {
    if origin != browser::extension_origin() {
        eprintln!("zv: {origin} is not the Zvault extension");
        return 64;
    }
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    // Pairing and unpairing change the credentials file; one at a time.
    let store_lock = Arc::new(Mutex::new(()));
    let mut stdin = std::io::stdin().lock();
    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(Some(f)) => f,
            Ok(None) => return 0,
            Err(e) => {
                eprintln!("zv: {e}");
                return 1;
            }
        };
        let Ok(Envelope { id, message }) = serde_json::from_slice::<Envelope>(&frame) else {
            send(
                &out,
                &json!({ "ok": false, "code": "badRequest", "message": "unreadable message" }),
            );
            continue;
        };
        let out = out.clone();
        let store_lock = store_lock.clone();
        std::thread::spawn(move || {
            let reply = match handle(&out, &id, message, &store_lock) {
                Ok(mut v) => {
                    v["id"] = id;
                    v["ok"] = Value::Bool(true);
                    v
                }
                Err(e) => json!({
                    "id": id,
                    "ok": false,
                    "code": e.code(),
                    "message": e.to_string(),
                }),
            };
            send(&out, &reply);
        });
    }
}

fn socket() -> Result<PathBuf, HostError> {
    Ok(paths::socket_path().ok_or(ClientError::NoSocketPath)?)
}

fn saved_auth() -> Result<Option<zvault_agent::protocol::AgentAuth>, HostError> {
    let store = Store::load(&store_path()?)?;
    match store.agents.first() {
        Some(a) => Ok(Some(a.auth()?)),
        None => Ok(None),
    }
}

/// Asks the app as the paired extension.
fn as_browser(body: RequestBody) -> Result<Response, HostError> {
    let auth = saved_auth()?.ok_or(HostError::NotPaired)?;
    Ok(client::request(&socket()?, Some(auth), body)?)
}

fn handle(
    out: &Out,
    id: &Value,
    message: Message,
    store_lock: &Mutex<()>,
) -> Result<Value, HostError> {
    match message {
        Message::Status => status(),
        Message::Pair { name } => {
            let _guard = store_lock.lock().unwrap_or_else(|e| e.into_inner());
            let code = new_pairing_code();
            send(
                out,
                &json!({ "id": id, "event": "pairingCode", "code": code }),
            );
            let name = name
                .as_deref()
                .and_then(zvault_agent::policy::clean_name)
                .unwrap_or_else(|| DEFAULT_NAME.to_owned());
            let reply = client::request(&socket()?, None, RequestBody::BrowserPair { name, code })?;
            let Response::Paired {
                agent_id,
                name,
                token,
            } = reply
            else {
                return Err(ClientError::Unexpected.into());
            };
            let path = store_path()?;
            let mut store = Store::load(&path)?;
            for old in std::mem::take(&mut store.agents) {
                let _ = store.remove(&old.agent_id);
            }
            store.add(CREDENTIAL_NAME, &agent_id, token)?;
            store.save(&path)?;
            Ok(json!({ "paired": true, "name": name }))
        }
        Message::Unpair => {
            let _guard = store_lock.lock().unwrap_or_else(|e| e.into_inner());
            // The app may already have forgotten it; forget it here anyway.
            let _ = as_browser(RequestBody::Unpair);
            forget()?;
            Ok(json!({ "paired": false }))
        }
        Message::Unlock => {
            client::request(&socket()?, None, RequestBody::Unlock)?;
            Ok(json!({}))
        }
        Message::Logins { url, top_url } => {
            match as_browser(RequestBody::BrowserLogins { url, top_url })? {
                Response::Logins { logins } => Ok(json!({ "logins": logins })),
                _ => Err(ClientError::Unexpected.into()),
            }
        }
        Message::Fill {
            item,
            url,
            top_url,
            otp_only,
        } => match as_browser(RequestBody::BrowserFill {
            item,
            url,
            top_url,
            otp_only,
        })? {
            Response::Fill(fill) => Ok(json!({ "fill": fill })),
            _ => Err(ClientError::Unexpected.into()),
        },
        Message::SaveCheck {
            url,
            top_url,
            username,
            password,
        } => match as_browser(RequestBody::BrowserSaveCheck {
            url,
            top_url,
            username,
            password,
        })? {
            Response::SaveCheck(check) => Ok(json!({ "check": check })),
            _ => Err(ClientError::Unexpected.into()),
        },
        Message::Save {
            url,
            top_url,
            username,
            password,
            item,
        } => match as_browser(RequestBody::BrowserSave {
            url,
            top_url,
            username,
            password,
            item,
        })? {
            Response::Changed { message } => Ok(json!({ "message": message })),
            _ => Err(ClientError::Unexpected.into()),
        },
    }
}

fn forget() -> Result<(), HostError> {
    let path = store_path()?;
    let mut store = Store::load(&path)?;
    for old in std::mem::take(&mut store.agents) {
        store.remove(&old.agent_id)?;
    }
    store.save(&path)?;
    Ok(())
}

fn status() -> Result<Value, HostError> {
    let socket = socket()?;
    let locked = match client::request(&socket, None, RequestBody::AppStatus) {
        Ok(Response::AppStatus { locked, .. }) => locked,
        Ok(_) => return Err(ClientError::Unexpected.into()),
        Err(ClientError::NotRunning(_)) => {
            return Ok(
                json!({ "running": false, "locked": true, "paired": saved_auth()?.is_some() }),
            );
        }
        Err(e) => return Err(e.into()),
    };
    let Some(auth) = saved_auth()? else {
        return Ok(json!({ "running": true, "locked": locked, "paired": false }));
    };
    match client::request(&socket, Some(auth), RequestBody::Status) {
        Ok(Response::Status(s)) => Ok(json!({
            "running": true,
            "locked": locked,
            "paired": true,
            "name": s.name,
            "paused": s.paused,
        })),
        // Unpaired in the app: forget the token so the extension offers to
        // pair again.
        Err(ClientError::App {
            code: ErrorCode::Unauthorized,
            ..
        }) => {
            forget()?;
            Ok(json!({ "running": true, "locked": locked, "paired": false }))
        }
        Ok(_) => Err(ClientError::Unexpected.into()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_how_chrome_starts_a_host() {
        assert!(started_by_browser(Some(
            "chrome-extension://koohciaalhgmbjmpnenehibgcfndkgdf/"
        )));
        assert!(!started_by_browser(Some("status")));
        assert!(!started_by_browser(None));
    }

    #[test]
    fn reads_the_extensions_messages() {
        let e: Envelope = serde_json::from_str(
            r#"{"id":7,"type":"fill","item":"i","url":"https://a.com/","topUrl":"https://a.com/","otpOnly":true}"#,
        )
        .unwrap();
        assert_eq!(e.id, json!(7));
        assert!(matches!(e.message, Message::Fill { otp_only: true, .. }));
        let e: Envelope = serde_json::from_str(r#"{"id":"x","type":"status"}"#).unwrap();
        assert!(matches!(e.message, Message::Status));
        let e: Envelope = serde_json::from_str(
            r#"{"id":3,"type":"save","url":"https://a.test/","username":"me","password":"pw","item":"i1"}"#,
        )
        .unwrap();
        assert!(matches!(e.message, Message::Save { item: Some(_), .. }));
        assert!(serde_json::from_str::<Envelope>(r#"{"id":1,"type":"read"}"#).is_err());
    }

    #[test]
    fn app_errors_become_codes_the_extension_knows() {
        let e = HostError::Client(ClientError::App {
            code: ErrorCode::Locked,
            message: String::new(),
        });
        assert_eq!(e.code(), "locked");
        assert_eq!(
            HostError::Client(ClientError::NotRunning("x".into())).code(),
            "notRunning"
        );
        assert_eq!(HostError::NotPaired.code(), "notPaired");
    }
}

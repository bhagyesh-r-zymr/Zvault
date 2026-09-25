//! The wire protocol between `zv` and the desktop app.
//!
//! One request and one response per connection, each a single line of JSON.
//! The socket is only reachable by the same OS user (the app checks the peer's
//! uid), so the protocol's own authentication is the per-agent bearer token
//! issued at pairing, which the app stores only as a SHA-256 hash.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::manage::{Change, ItemContents, ItemInfo, ItemPatch, ProjectInfo};
use crate::policy::ApprovalMode;
use crate::reference::{ScopePattern, SecretRef};

pub const PROTOCOL_VERSION: u32 = 1;
/// Largest line either side accepts.
pub const MAX_MESSAGE: usize = 256 * 1024;
/// Most references one request may ask for.
pub const MAX_REFS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuth {
    pub agent_id: String,
    pub token: Zeroizing<String>,
}

/// A request comes from a paired agent when `auth` is set, and otherwise from
/// the user at a terminal. The user's requests are approved in the app (or by
/// a `zv signin` grant for that terminal); an agent's follow its policy.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub v: u32,
    #[serde(default)]
    pub auth: Option<AgentAuth>,
    pub body: RequestBody,
}

/// What the secret is for, shown in the approval prompt and the activity log.
/// It is reported by the CLI, so the app labels it as such.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purpose {
    pub kind: PurposeKind,
    /// The child command for `zv run`, trimmed to a few hundred bytes.
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// What a change does, written by the app from the change itself (never
    /// taken from the CLI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The change deletes something.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub destructive: bool,
}

impl Purpose {
    /// A purpose the app states itself, for requests that carry none.
    pub fn app(kind: PurposeKind, detail: Option<String>) -> Self {
        Self {
            kind,
            command: vec![],
            cwd: None,
            detail,
            destructive: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PurposeKind {
    Run,
    Read,
    /// `zv env`: every secret in an environment or folder.
    Export,
    /// `zv ls`: names only.
    List,
    /// `zv copy`: the app puts the value on the clipboard itself.
    Copy,
    /// `zv set`: changes a secret.
    Set,
    /// `zv signin`: lets this terminal skip prompts for a while.
    SignIn,
    /// Creates, renames or deletes a project, environment, folder or secret.
    Change,
    /// `zv item get`: an item from the personal vault, password included.
    ReadItem,
    /// `zv item create`, `edit` or `delete`.
    ChangeItem,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RequestBody {
    /// Asks the user to pair a new agent. `code` is shown in the terminal and
    /// in the app so the user can tell the prompt is for this terminal.
    #[serde(rename_all = "camelCase")]
    Pair { name: String, code: String },
    /// Asks for secret values. Needs `auth`.
    #[serde(rename_all = "camelCase")]
    Fetch {
        refs: Vec<SecretRef>,
        purpose: Purpose,
    },
    /// Returns this agent's settings. Needs `auth`.
    Status,
    /// Removes this agent. Needs `auth`.
    Unpair,
    /// Whether the app is locked and this terminal is signed in. Reveals
    /// nothing else, so it needs no approval.
    AppStatus,
    /// Brings Zvault forward and waits until the user unlocks it.
    Unlock,
    /// Lets this terminal session use secrets without a prompt for a while.
    /// User only.
    SignIn,
    /// Ends this terminal session's sign-in. User only.
    SignOut,
    /// Lists secret paths under `prefix` (everything when `None`). An agent
    /// sees only secrets inside its scopes.
    #[serde(rename_all = "camelCase")]
    List { prefix: Option<ScopePattern> },
    /// Returns the value of every secret under `prefix`.
    #[serde(rename_all = "camelCase")]
    Export {
        prefix: ScopePattern,
        purpose: Purpose,
    },
    /// Copies a value to the clipboard in the app, which clears it later.
    /// The value never reaches `zv`. User only.
    #[serde(rename_all = "camelCase")]
    Copy { reference: SecretRef },
    /// Sets a secret's value in its environment, creating the secret if
    /// needed. User only.
    #[serde(rename_all = "camelCase")]
    Set {
        reference: SecretRef,
        value: Zeroizing<String>,
    },
    /// Projects with their environments and folders, by name. An agent sees
    /// only what its scopes reach.
    Structure,
    /// Changes projects, environments, folders or secrets. User only, and
    /// always approved in the app.
    #[serde(rename_all = "camelCase")]
    Change { change: Change },
    /// Lists the items in the personal vault, without passwords. User only.
    Items,
    /// One item's contents, found by id or by title. User only.
    #[serde(rename_all = "camelCase")]
    ItemGet { item: String },
    /// Creates an item (`item` absent) or changes one. User only, and always
    /// approved in the app.
    #[serde(rename_all = "camelCase")]
    ItemPut {
        item: Option<String>,
        patch: ItemPatch,
    },
    /// Deletes an item. User only, and always approved in the app.
    #[serde(rename_all = "camelCase")]
    ItemDelete { item: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    pub reference: SecretRef,
    pub value: Zeroizing<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent_id: String,
    pub name: String,
    pub paused: bool,
    pub approval: ApprovalMode,
    pub scopes: Vec<ScopePattern>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    #[serde(rename_all = "camelCase")]
    Paired {
        agent_id: String,
        name: String,
        token: Zeroizing<String>,
    },
    Secrets {
        values: Vec<SecretValue>,
    },
    Status(AgentStatus),
    #[serde(rename_all = "camelCase")]
    AppStatus {
        locked: bool,
        /// Whether this terminal session is signed in.
        signed_in: bool,
        /// Seconds the sign-in has left.
        signed_in_secs: Option<u64>,
    },
    List {
        refs: Vec<SecretRef>,
    },
    #[serde(rename_all = "camelCase")]
    Copied {
        clear_after_secs: u32,
    },
    Structure {
        projects: Vec<ProjectInfo>,
    },
    /// A change was made. `message` says what, for people.
    Changed {
        message: String,
    },
    Items {
        items: Vec<ItemInfo>,
    },
    Item(ItemContents),
    Ok,
    Error {
        code: ErrorCode,
        message: String,
    },
}

impl Response {
    pub fn error(code: ErrorCode) -> Self {
        Self::Error {
            code,
            message: code.message().into(),
        }
    }
}

/// Why a request failed. Denials say which rule applied, never anything about
/// secrets the agent cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    BadRequest,
    UnsupportedVersion,
    Unauthorized,
    Paused,
    OutOfScope,
    Locked,
    Denied,
    Timeout,
    NotFound,
    Busy,
    AgentsOnly,
    UserOnly,
    /// The app turned the change down; the message says why.
    Rejected,
    Internal,
}

impl ErrorCode {
    pub fn message(self) -> &'static str {
        match self {
            Self::BadRequest => "the request was malformed",
            Self::UnsupportedVersion => "this zv is not compatible with the running Zvault app",
            Self::Unauthorized => "this agent is not paired with Zvault; run `zv agent pair`",
            Self::Paused => "this agent is paused in Zvault",
            Self::OutOfScope => "this agent is not allowed to use that secret",
            Self::Locked => "Zvault is locked; unlock the app and try again",
            Self::Denied => "the request was denied in Zvault",
            Self::Timeout => "nobody answered the request in Zvault",
            Self::NotFound => "that secret does not exist",
            Self::Busy => "Zvault is already showing a request; try again",
            Self::AgentsOnly => "that command is for paired agents; pass --agent",
            Self::UserOnly => "agents cannot do that; run it yourself without --agent",
            Self::Rejected => "Zvault could not make that change",
            Self::Internal => "Zvault could not complete the request",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("connection error: {0}")]
    Io(#[from] std::io::Error),
    #[error("message too large")]
    TooLarge,
    #[error("malformed message")]
    Malformed,
    #[error("connection closed")]
    Closed,
}

/// Writes one message as a JSON line.
pub fn write_message<T: Serialize>(w: &mut impl Write, msg: &T) -> Result<(), WireError> {
    let mut line = Zeroizing::new(serde_json::to_vec(msg).map_err(|_| WireError::Malformed)?);
    if line.len() > MAX_MESSAGE {
        return Err(WireError::TooLarge);
    }
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()?;
    Ok(())
}

/// Reads one JSON line, refusing to buffer more than [`MAX_MESSAGE`] bytes.
pub fn read_message<T: for<'de> Deserialize<'de>>(r: &mut impl BufRead) -> Result<T, WireError> {
    let mut line = Zeroizing::new(Vec::new());
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Err(WireError::Closed);
        }
        let (chunk, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (&buf[..i], Some(i + 1)),
            None => (buf, None),
        };
        if line.len() + chunk.len() > MAX_MESSAGE {
            return Err(WireError::TooLarge);
        }
        line.extend_from_slice(chunk);
        let used = done.unwrap_or(buf.len());
        r.consume(used);
        if done.is_some() {
            break;
        }
    }
    serde_json::from_slice(&line).map_err(|_| WireError::Malformed)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn round_trips_a_request() {
        let req = Request {
            v: PROTOCOL_VERSION,
            auth: Some(AgentAuth {
                agent_id: "a1".into(),
                token: Zeroizing::new("t".into()),
            }),
            body: RequestBody::Fetch {
                refs: vec!["zv://web/dev/db".parse().unwrap()],
                purpose: Purpose {
                    kind: PurposeKind::Run,
                    command: vec!["npm".into(), "test".into()],
                    cwd: None,
                    detail: None,
                    destructive: false,
                },
            },
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &req).unwrap();
        assert_eq!(buf.last(), Some(&b'\n'));
        let back: Request = read_message(&mut Cursor::new(buf)).unwrap();
        match back.body {
            RequestBody::Fetch { refs, purpose } => {
                assert_eq!(refs[0].to_string(), "zv://web/dev/db");
                assert_eq!(purpose.command, ["npm", "test"]);
            }
            _ => panic!("wrong body"),
        }
    }

    #[test]
    fn refuses_oversized_and_malformed_lines() {
        let big = vec![b'x'; MAX_MESSAGE + 1];
        assert!(matches!(
            read_message::<Request>(&mut Cursor::new(big)),
            Err(WireError::TooLarge)
        ));
        assert!(matches!(
            read_message::<Request>(&mut Cursor::new(b"{nope}\n".to_vec())),
            Err(WireError::Malformed)
        ));
        assert!(matches!(
            read_message::<Request>(&mut Cursor::new(Vec::new())),
            Err(WireError::Closed)
        ));
        // A bad reference fails the whole request.
        let bad = br#"{"v":1,"body":{"type":"fetch","refs":["zv://x"],"purpose":{"kind":"read"}}}"#;
        let mut line = bad.to_vec();
        line.push(b'\n');
        assert!(read_message::<Request>(&mut Cursor::new(line)).is_err());
    }

    #[test]
    fn change_requests_round_trip() {
        let req = Request {
            v: PROTOCOL_VERSION,
            auth: None,
            body: RequestBody::Change {
                change: Change::CreateEnvironment {
                    project: "web".into(),
                    name: "QA".into(),
                    slug: None,
                    kind: None,
                    inherits_from: Some("development".into()),
                },
            },
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &req).unwrap();
        let text = String::from_utf8(buf.clone()).unwrap();
        assert!(text.contains(r#""type":"change""#), "{text}");
        let back: Request = read_message(&mut Cursor::new(buf)).unwrap();
        assert!(matches!(
            back.body,
            RequestBody::Change {
                change: Change::CreateEnvironment { .. }
            }
        ));
    }

    #[test]
    fn error_responses_carry_a_code() {
        let json = serde_json::to_string(&Response::error(ErrorCode::OutOfScope)).unwrap();
        assert!(json.contains("\"code\":\"outOfScope\""), "{json}");
    }
}

//! Talks to the Zvault app over its local socket.

use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use zvault_agent::protocol::{
    self, AgentAuth, ErrorCode, PROTOCOL_VERSION, Request, RequestBody, Response,
};

/// Long enough for the user to notice the prompt and use Touch ID. The app
/// gives up on its own prompt before this.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Zvault is not running, or agent access is turned off (no socket at {0})")]
    NotRunning(String),
    #[error("could not find the Zvault app's data directory; set ZV_SOCKET")]
    NoSocketPath,
    #[error("{message}")]
    App { code: ErrorCode, message: String },
    #[error("lost the connection to Zvault: {0}")]
    Wire(#[from] protocol::WireError),
    #[error("Zvault sent an unexpected response")]
    Unexpected,
}

impl ClientError {
    /// Exit status for scripts: 2 not reachable, 3 not paired, 4 denied or
    /// out of scope, 5 locked, 1 anything else.
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::NotRunning(_) | Self::NoSocketPath => 2,
            Self::App { code, .. } => match code {
                ErrorCode::Unauthorized => 3,
                ErrorCode::Denied
                | ErrorCode::OutOfScope
                | ErrorCode::Paused
                | ErrorCode::Timeout => 4,
                ErrorCode::Locked => 5,
                _ => 1,
            },
            _ => 1,
        }
    }
}

pub fn request(
    socket: &Path,
    auth: Option<AgentAuth>,
    body: RequestBody,
) -> Result<Response, ClientError> {
    let stream = UnixStream::connect(socket)
        .map_err(|_| ClientError::NotRunning(socket.display().to_string()))?;
    stream.set_read_timeout(Some(RESPONSE_TIMEOUT)).ok();
    let mut writer = stream.try_clone().map_err(protocol::WireError::from)?;
    protocol::write_message(
        &mut writer,
        &Request {
            v: PROTOCOL_VERSION,
            auth,
            body,
        },
    )?;
    let response: Response = protocol::read_message(&mut BufReader::new(stream))?;
    match response {
        Response::Error { code, message } => Err(ClientError::App { code, message }),
        other => Ok(other),
    }
}

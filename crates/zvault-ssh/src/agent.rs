//! The SSH agent protocol (draft-miller-ssh-agent): the part `ssh`, `git`
//! and `ssh-add -l` use. The agent lists keys and signs; it never adds,
//! removes or exports keys over the socket, so every other request gets
//! `SSH_AGENT_FAILURE`.
//!
//! Each message is a `uint32` length followed by that many bytes, the first
//! of which is the message type.

use std::io::{self, Read, Write};

pub const SSH_AGENT_FAILURE: u8 = 5;
pub const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
pub const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
pub const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
pub const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

/// Sign-request flags choosing the RSA hash (RFC 8332).
pub const SSH_AGENT_RSA_SHA2_256: u32 = 2;
pub const SSH_AGENT_RSA_SHA2_512: u32 = 4;

/// Largest message either side accepts, as in OpenSSH's agent.
pub const MAX_MESSAGE: usize = 256 * 1024;

const SSH_MSG_USERAUTH_REQUEST: u8 = 50;
const SSHSIG_MAGIC: &[u8] = b"SSHSIG";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    RequestIdentities,
    Sign {
        /// The public key, in SSH wire format.
        key_blob: Vec<u8>,
        data: Vec<u8>,
        flags: u32,
    },
    /// Anything else, by message type. Answered with a failure.
    Unsupported(u8),
}

/// One key as listed to clients.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub key_blob: Vec<u8>,
    pub comment: String,
}

/// Reads one message. `Ok(None)` means the client closed the connection.
pub fn read_request(r: &mut impl Read) -> io::Result<Option<Request>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_MESSAGE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad length"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    parse_request(&body).map(Some)
}

pub fn parse_request(body: &[u8]) -> io::Result<Request> {
    let (&kind, mut rest) = body.split_first().ok_or_else(invalid)?;
    Ok(match kind {
        SSH_AGENTC_REQUEST_IDENTITIES => Request::RequestIdentities,
        SSH_AGENTC_SIGN_REQUEST => {
            let key_blob = string(&mut rest).ok_or_else(invalid)?.to_vec();
            let data = string(&mut rest).ok_or_else(invalid)?.to_vec();
            let flags = u32_be(&mut rest).ok_or_else(invalid)?;
            Request::Sign {
                key_blob,
                data,
                flags,
            }
        }
        other => Request::Unsupported(other),
    })
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "malformed agent message")
}

pub fn write_identities(w: &mut impl Write, ids: &[Identity]) -> io::Result<()> {
    let mut body = vec![SSH_AGENT_IDENTITIES_ANSWER];
    put_u32(&mut body, u32::try_from(ids.len()).map_err(|_| invalid())?);
    for id in ids {
        put_string(&mut body, &id.key_blob)?;
        put_string(&mut body, id.comment.as_bytes())?;
    }
    write_frame(w, &body)
}

/// `signature` is the SSH-encoded signature (algorithm name and blob).
pub fn write_signature(w: &mut impl Write, signature: &[u8]) -> io::Result<()> {
    let mut body = vec![SSH_AGENT_SIGN_RESPONSE];
    put_string(&mut body, signature)?;
    write_frame(w, &body)
}

pub fn write_failure(w: &mut impl Write) -> io::Result<()> {
    write_frame(w, &[SSH_AGENT_FAILURE])
}

fn write_frame(w: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let len = u32::try_from(body.len()).map_err(|_| invalid())?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(body)?;
    w.flush()
}

/// What a client asked to sign, for the approval prompt. Read from the data
/// itself, so it is only as trustworthy as the client that sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignPurpose {
    /// Logging in to a server (`ssh`, `git fetch`, `git push`).
    Login { user: String },
    /// An SSHSIG signature, such as a signed git commit (`namespace` "git")
    /// or a file (`ssh-keygen -Y sign`).
    Signature { namespace: String },
    Unknown,
}

pub fn sign_purpose(data: &[u8]) -> SignPurpose {
    if let Some(mut rest) = data.strip_prefix(SSHSIG_MAGIC) {
        return match string(&mut rest) {
            Some(ns) => SignPurpose::Signature {
                namespace: printable(ns),
            },
            None => SignPurpose::Unknown,
        };
    }
    let mut rest = data;
    let login = (|| {
        string(&mut rest)?; // session id
        let (&kind, r) = rest.split_first()?;
        rest = r;
        if kind != SSH_MSG_USERAUTH_REQUEST {
            return None;
        }
        let user = string(&mut rest)?;
        let _service = string(&mut rest)?;
        let method = string(&mut rest)?;
        (method == b"publickey").then(|| printable(user))
    })();
    match login {
        Some(user) => SignPurpose::Login { user },
        None => SignPurpose::Unknown,
    }
}

/// Text from a client, cut short and without control characters.
fn printable(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect()
}

fn u32_be(input: &mut &[u8]) -> Option<u32> {
    let (head, rest) = input.split_first_chunk::<4>()?;
    *input = rest;
    Some(u32::from_be_bytes(*head))
}

fn string<'a>(input: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = u32_be(input)? as usize;
    if input.len() < len {
        return None;
    }
    let (s, rest) = input.split_at(len);
    *input = rest;
    Some(s)
}

fn put_u32(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_be_bytes());
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) -> io::Result<()> {
    put_u32(out, u32::try_from(s.len()).map_err(|_| invalid())?);
    out.extend_from_slice(s);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &[u8]) -> Vec<u8> {
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(body);
        out
    }

    fn strings(parts: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts {
            put_string(&mut out, p).unwrap();
        }
        out
    }

    #[test]
    fn reads_requests() {
        let wire = frame(&[SSH_AGENTC_REQUEST_IDENTITIES]);
        assert_eq!(
            read_request(&mut &wire[..]).unwrap(),
            Some(Request::RequestIdentities)
        );
        let mut body = vec![SSH_AGENTC_SIGN_REQUEST];
        body.extend(strings(&[b"KEY", b"DATA"]));
        body.extend(4u32.to_be_bytes());
        assert_eq!(
            read_request(&mut &frame(&body)[..]).unwrap(),
            Some(Request::Sign {
                key_blob: b"KEY".to_vec(),
                data: b"DATA".to_vec(),
                flags: 4
            })
        );
        // ssh-add, lock, extensions...
        assert_eq!(
            read_request(&mut &frame(&[17, 0, 0])[..]).unwrap(),
            Some(Request::Unsupported(17))
        );
        assert_eq!(read_request(&mut &[][..]).unwrap(), None);
    }

    #[test]
    fn refuses_malformed_messages() {
        assert!(read_request(&mut &[0u8, 0, 0, 0][..]).is_err());
        assert!(read_request(&mut &(MAX_MESSAGE as u32 + 1).to_be_bytes()[..]).is_err());
        let mut body = vec![SSH_AGENTC_SIGN_REQUEST];
        body.extend(99u32.to_be_bytes());
        assert!(parse_request(&body).is_err());
        assert!(read_request(&mut &[0u8, 0, 0, 5, 11][..]).is_err());
    }

    #[test]
    fn writes_answers() {
        let mut out = Vec::new();
        write_identities(
            &mut out,
            &[Identity {
                key_blob: b"K".to_vec(),
                comment: "c".into(),
            }],
        )
        .unwrap();
        assert_eq!(
            out,
            frame(&[12, 0, 0, 0, 1, 0, 0, 0, 1, b'K', 0, 0, 0, 1, b'c'])
        );
        out.clear();
        write_signature(&mut out, b"S").unwrap();
        assert_eq!(out, frame(&[14, 0, 0, 0, 1, b'S']));
        out.clear();
        write_failure(&mut out).unwrap();
        assert_eq!(out, frame(&[5]));
    }

    #[test]
    fn describes_what_is_signed() {
        let mut login = strings(&[b"session"]);
        login.push(SSH_MSG_USERAUTH_REQUEST);
        login.extend(strings(&[b"git", b"ssh-connection", b"publickey"]));
        login.push(1);
        login.extend(strings(&[b"ssh-ed25519", b"KEY"]));
        assert_eq!(
            sign_purpose(&login),
            SignPurpose::Login { user: "git".into() }
        );

        let mut sig = b"SSHSIG".to_vec();
        sig.extend(strings(&[b"git", b"", b"sha512", b"HASH"]));
        assert_eq!(
            sign_purpose(&sig),
            SignPurpose::Signature {
                namespace: "git".into()
            }
        );
        assert_eq!(sign_purpose(b"random"), SignPurpose::Unknown);

        let mut evil = strings(&[b"s"]);
        evil.push(SSH_MSG_USERAUTH_REQUEST);
        evil.extend(strings(&[b"ro\not\x1b[31m", b"ssh-connection", b"publickey"]));
        assert_eq!(
            sign_purpose(&evil),
            SignPurpose::Login {
                user: "root[31m".into()
            }
        );
    }
}

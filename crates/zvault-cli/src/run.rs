//! `zv run`: starts a command with secrets in its environment and masks them
//! in what it prints.

use std::io::{Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::thread;

use zeroize::Zeroizing;
use zvault_agent::mask::Masker;

/// Environment variable names `zv run` accepts.
pub fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Runs `argv` with `env` added to its environment only. With `mask`, its
/// stdout and stderr are piped through a [`Masker`]; without, they are
/// inherited (the child keeps the terminal).
pub fn run(
    argv: &[String],
    env: &[(String, Zeroizing<String>)],
    mask: bool,
) -> std::io::Result<ExitStatus> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::other("no command given"))?;
    let mut cmd = Command::new(program);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v.as_str());
    }
    if !mask {
        return cmd.status();
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let secrets: Arc<Vec<Zeroizing<Vec<u8>>>> = Arc::new(
        env.iter()
            .map(|(_, v)| Zeroizing::new(v.as_bytes().to_vec()))
            .collect(),
    );
    let out = child.stdout.take().map(|r| {
        let s = Arc::clone(&secrets);
        thread::spawn(move || pump(r, std::io::stdout(), &s))
    });
    let err = child.stderr.take().map(|r| {
        let s = Arc::clone(&secrets);
        thread::spawn(move || pump(r, std::io::stderr(), &s))
    });
    let status = child.wait()?;
    for t in [out, err].into_iter().flatten() {
        let _ = t.join();
    }
    Ok(status)
}

fn pump(mut from: impl Read, mut to: impl Write, secrets: &[Zeroizing<Vec<u8>>]) {
    let mut masker = Masker::new(secrets.iter().map(|s| s.as_slice()));
    let mut buf = Zeroizing::new(vec![0u8; 8192]);
    loop {
        match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let masked = masker.push(&buf[..n]);
                if to.write_all(&masked).and_then(|()| to.flush()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let _ = to.write_all(&masker.finish());
    let _ = to.flush();
}

/// Exit status to return for the child: its own code, or 128 + signal.
pub fn exit_code(status: ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => u8::try_from(c & 0xff).unwrap_or(1),
        (None, Some(sig)) => u8::try_from((128 + sig) & 0xff).unwrap_or(1),
        (None, None) => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_env_names() {
        for ok in ["DATABASE_URL", "_X", "a1"] {
            assert!(valid_env_name(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A=B", "Ä"] {
            assert!(!valid_env_name(bad), "{bad}");
        }
    }

    #[test]
    fn passes_env_only_to_the_child_and_returns_its_code() {
        let env = vec![(
            "ZV_TEST_SECRET".to_owned(),
            Zeroizing::new("s3cret-value".to_owned()),
        )];
        let status = run(
            &[
                "sh".into(),
                "-c".into(),
                "test \"$ZV_TEST_SECRET\" = s3cret-value && exit 7".into(),
            ],
            &env,
            true,
        )
        .unwrap();
        assert_eq!(exit_code(status), 7);
        assert!(std::env::var("ZV_TEST_SECRET").is_err());
    }
}

//! `zv`: lets local AI agents and scripts use secrets approved in Zvault.
//!
//! `zv` holds no vault keys. It asks the running Zvault app for specific
//! `zv://` references, and the app decides, per paired agent, whether to
//! release them and whether to ask the user first.

mod client;
mod credentials;
mod run;

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use zeroize::Zeroizing;
use zvault_agent::SecretRef;
use zvault_agent::paths;
use zvault_agent::policy::new_pairing_code;
use zvault_agent::protocol::{AgentStatus, Purpose, PurposeKind, RequestBody, Response};

use crate::client::ClientError;
use crate::credentials::{CredError, Store};

#[derive(Parser)]
#[command(
    name = "zv",
    version,
    about = "Use secrets approved in Zvault from scripts and AI agents"
)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Pair, inspect or remove agents.
    #[command(subcommand)]
    Agent(AgentCmd),
    /// Run a command with secrets in its environment.
    ///
    /// Secrets go only into the child's environment and are masked in its
    /// output. Example: zv run --env DATABASE_URL=zv://web/dev/db -- npm test
    Run {
        #[command(flatten)]
        who: Who,
        /// KEY=zv://project/environment/[folder/]item[#field]; repeatable.
        #[arg(short, long = "env", value_name = "KEY=REF", required = true)]
        env: Vec<String>,
        /// Let the command use the terminal directly and do not mask output.
        #[arg(long)]
        no_mask: bool,
        /// The command and its arguments, after `--`.
        #[arg(last = true, required = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
    /// Print one secret to stdout.
    Read {
        #[command(flatten)]
        who: Who,
        /// zv://project/environment/[folder/]item[#field]
        reference: String,
        /// Do not add a newline after the value.
        #[arg(short = 'n', long)]
        no_newline: bool,
    },
}

#[derive(Subcommand)]
enum AgentCmd {
    /// Pair this machine's agent with Zvault. Approve it in the app.
    Pair {
        /// How the agent appears in Zvault, for example "Claude Code".
        #[arg(long)]
        name: String,
    },
    /// Show an agent's access as Zvault sees it.
    Status {
        #[command(flatten)]
        who: Who,
    },
    /// List the agents paired on this machine.
    List,
    /// Remove an agent from Zvault and from this machine.
    Unpair {
        #[command(flatten)]
        who: Who,
    },
}

#[derive(Args)]
struct Who {
    /// Which paired agent to act as (default: $ZV_AGENT, or the only one).
    #[arg(long, global = true)]
    agent: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Cred(#[from] CredError),
    #[error("{0}")]
    Usage(String),
    #[error("could not start the command: {0}")]
    Spawn(std::io::Error),
}

impl Error {
    fn exit_code(&self) -> u8 {
        match self {
            Self::Client(e) => e.exit_code(),
            Self::Cred(CredError::NonePaired | CredError::Unknown(_)) => 3,
            Self::Usage(_) => 64,
            Self::Spawn(_) => 127,
            Self::Cred(_) => 1,
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(cli.command) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("zv: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}

fn socket() -> Result<PathBuf, Error> {
    paths::socket_path().ok_or(Error::Client(ClientError::NoSocketPath))
}

fn dispatch(cmd: Cmd) -> Result<u8, Error> {
    let store_path = credentials::default_path()?;
    match cmd {
        Cmd::Agent(AgentCmd::Pair { name }) => pair(&store_path, &name),
        Cmd::Agent(AgentCmd::List) => {
            let store = Store::load(&store_path)?;
            if store.agents.is_empty() {
                println!("No agents are paired on this machine.");
            }
            for a in &store.agents {
                println!("{}\t{}", a.name, a.agent_id);
            }
            Ok(0)
        }
        Cmd::Agent(AgentCmd::Status { who }) => {
            let store = Store::load(&store_path)?;
            let agent = store.select(who.agent.as_deref())?;
            match client::request(&socket()?, Some(agent.auth()?), RequestBody::Status)? {
                Response::Status(s) => {
                    print_status(&s);
                    Ok(0)
                }
                _ => Err(ClientError::Unexpected.into()),
            }
        }
        Cmd::Agent(AgentCmd::Unpair { who }) => {
            let mut store = Store::load(&store_path)?;
            let agent = store.select(who.agent.as_deref())?.clone();
            match client::request(&socket()?, Some(agent.auth()?), RequestBody::Unpair) {
                // Already gone from the app: still forget it here.
                Ok(_) | Err(ClientError::App { .. }) => {}
                Err(e) => return Err(e.into()),
            }
            store.remove(&agent.agent_id)?;
            store.save(&store_path)?;
            println!("Unpaired {}.", agent.name);
            Ok(0)
        }
        Cmd::Run {
            who,
            env,
            no_mask,
            command,
        } => {
            let mut pairs = Vec::with_capacity(env.len());
            for spec in &env {
                let (key, reference) = spec
                    .split_once('=')
                    .ok_or_else(|| Error::Usage(format!("--env takes KEY=REF, got {spec:?}")))?;
                if !run::valid_env_name(key) {
                    return Err(Error::Usage(format!(
                        "{key:?} is not a valid variable name"
                    )));
                }
                if pairs.iter().any(|(k, _): &(String, SecretRef)| k == key) {
                    return Err(Error::Usage(format!("{key} is set twice")));
                }
                let reference: SecretRef = reference
                    .parse()
                    .map_err(|e| Error::Usage(format!("{reference}: {e}")))?;
                pairs.push((key.to_owned(), reference));
            }
            let refs: Vec<SecretRef> = pairs.iter().map(|(_, r)| r.clone()).collect();
            let values = fetch(
                &store_path,
                who.agent.as_deref(),
                refs,
                PurposeKind::Run,
                &command,
            )?;
            let env: Vec<(String, Zeroizing<String>)> = pairs
                .into_iter()
                .map(|(k, r)| {
                    let v = values
                        .iter()
                        .find(|(vr, _)| *vr == r)
                        .map(|(_, v)| v.clone())
                        .ok_or(ClientError::Unexpected)?;
                    Ok((k, v))
                })
                .collect::<Result<_, Error>>()?;
            let status = run::run(&command, &env, !no_mask).map_err(Error::Spawn)?;
            Ok(run::exit_code(status))
        }
        Cmd::Read {
            who,
            reference,
            no_newline,
        } => {
            let reference: SecretRef = reference
                .parse()
                .map_err(|e| Error::Usage(format!("{reference}: {e}")))?;
            let values = fetch(
                &store_path,
                who.agent.as_deref(),
                vec![reference],
                PurposeKind::Read,
                &[],
            )?;
            let (_, value) = values.into_iter().next().ok_or(ClientError::Unexpected)?;
            if std::io::stdout().is_terminal() {
                eprintln!("zv: printing a secret to the terminal");
            }
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(value.as_bytes());
            if !no_newline {
                let _ = out.write_all(b"\n");
            }
            let _ = out.flush();
            Ok(0)
        }
    }
}

fn pair(store_path: &std::path::Path, name: &str) -> Result<u8, Error> {
    let name = zvault_agent::policy::clean_name(name)
        .ok_or_else(|| Error::Usage("--name must not be empty".into()))?;
    let mut store = Store::load(store_path)?;
    if store
        .agents
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&name))
    {
        return Err(CredError::Exists(name).into());
    }
    let code = new_pairing_code();
    eprintln!("Approve \"{name}\" in Zvault. The app will show the code {code}.");
    match client::request(
        &socket()?,
        None,
        RequestBody::Pair {
            name: name.clone(),
            code,
        },
    )? {
        Response::Paired {
            agent_id,
            name,
            token,
        } => {
            store.add(&name, &agent_id, token)?;
            store.save(store_path)?;
            println!("Paired {name}. Choose which secrets it may use in Zvault > Agents.");
            Ok(0)
        }
        _ => Err(ClientError::Unexpected.into()),
    }
}

/// Keeps the command shown in the approval prompt short.
fn summarize(argv: &[String]) -> Vec<String> {
    const MAX_ARG: usize = 120;
    const MAX_ARGS: usize = 12;
    argv.iter()
        .take(MAX_ARGS)
        .map(|a| {
            if a.len() <= MAX_ARG {
                a.clone()
            } else {
                let mut end = MAX_ARG;
                while !a.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{}…", &a[..end])
            }
        })
        .collect()
}

fn fetch(
    store_path: &std::path::Path,
    agent: Option<&str>,
    mut refs: Vec<SecretRef>,
    kind: PurposeKind,
    command: &[String],
) -> Result<Vec<(SecretRef, Zeroizing<String>)>, Error> {
    let store = Store::load(store_path)?;
    let agent = store.select(agent)?;
    refs.sort();
    refs.dedup();
    let purpose = Purpose {
        kind,
        command: summarize(command),
        cwd: std::env::current_dir()
            .ok()
            .map(|d| d.display().to_string()),
    };
    match client::request(
        &socket()?,
        Some(agent.auth()?),
        RequestBody::Fetch { refs, purpose },
    )? {
        Response::Secrets { values } => {
            Ok(values.into_iter().map(|v| (v.reference, v.value)).collect())
        }
        _ => Err(ClientError::Unexpected.into()),
    }
}

fn print_status(s: &AgentStatus) {
    println!("Agent:     {} ({})", s.name, s.agent_id);
    println!("State:     {}", if s.paused { "paused" } else { "active" });
    let mode = match s.approval {
        zvault_agent::ApprovalMode::AskEveryTime => "ask every time",
        zvault_agent::ApprovalMode::Session15m => "ask once per 15 minutes",
        zvault_agent::ApprovalMode::WhileUnlocked => "allowed while Zvault is unlocked",
    };
    println!("Approval:  {mode}");
    if s.scopes.is_empty() {
        println!("Secrets:   none yet; choose them in Zvault > Agents");
    } else {
        println!("Secrets:");
        for scope in &s.scopes {
            println!("  {scope}");
        }
    }
}

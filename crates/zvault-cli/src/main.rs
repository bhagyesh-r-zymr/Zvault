//! `zv`: the Zvault command line, for you and for the AI agents you approve.
//!
//! `zv` holds no vault keys. Every command asks the running Zvault app, which
//! decides: for you, it asks for approval in the app (or lets a terminal that
//! ran `zv signin` go ahead for a while); for a paired agent (`--agent` or
//! `ZV_AGENT`), it applies that agent's scopes and approval mode.

mod client;
mod credentials;
mod format;
mod run;
mod update;

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use zeroize::Zeroizing;
use zvault_agent::policy::new_pairing_code;
use zvault_agent::protocol::{AgentAuth, AgentStatus, Purpose, PurposeKind, RequestBody, Response};
use zvault_agent::{ScopePattern, SecretRef, paths};

use crate::client::ClientError;
use crate::credentials::{AGENT_ENV, CredError, Store};
use crate::format::EnvFormat;

#[derive(Parser)]
#[command(
    name = "zv",
    version = update::VERSION,
    about = "Use your Zvault secrets from the terminal, scripts and AI agents",
    after_help = "Secrets are named zv://project/environment/[folder/]KEY, \
                  for example zv://payments-api/production/STRIPE_SECRET_KEY."
)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show whether Zvault is running, locked, and this terminal signed in.
    Status,
    /// Bring Zvault forward and wait until it is unlocked.
    Unlock,
    /// Approve this terminal for 10 minutes of use (at most an hour), so
    /// commands stop asking. Agents started from it share the approval.
    Signin,
    /// End this terminal's approval.
    Signout,
    /// List projects, environments, folders and secrets. Names only.
    Ls {
        #[command(flatten)]
        who: Who,
        /// zv://project[/environment[/folder/]]
        place: Option<String>,
        /// Print the full path of every secret below the place.
        #[arg(short = 'r', long)]
        recursive: bool,
    },
    /// Print one secret to stdout.
    Read {
        #[command(flatten)]
        who: Who,
        reference: String,
        /// Do not add a newline after the value.
        #[arg(short = 'n', long)]
        no_newline: bool,
    },
    /// Copy a secret to the clipboard. Zvault clears it after a while, and the
    /// value never passes through this terminal.
    Copy { reference: String },
    /// Set a secret's value in one environment, creating the secret if
    /// needed. Reads the value from stdin, hidden when typed.
    Set { reference: String },
    /// Print every secret in an environment or folder as variables.
    ///
    /// Each secret becomes the variable named by its KEY. Example:
    /// eval "$(zv env zv://web/development --format shell)"
    Env {
        #[command(flatten)]
        who: Who,
        /// zv://project/environment[/folder/]
        place: String,
        #[arg(long, value_enum, default_value = "dotenv")]
        format: EnvFormat,
    },
    /// Run a command with secrets in its environment.
    ///
    /// Secrets go only into the child's environment and are masked in its
    /// output. Example: zv run --env DATABASE_URL=zv://web/dev/db -- npm test
    Run {
        #[command(flatten)]
        who: Who,
        /// NAME=zv://project/environment/[folder/]KEY; repeatable.
        #[arg(short, long = "env", value_name = "NAME=PATH")]
        env: Vec<String>,
        /// Every secret in an environment or folder, by its KEY. `--env`
        /// wins where both set a variable.
        #[arg(long, value_name = "PLACE")]
        env_from: Option<String>,
        /// Let the command use the terminal directly and do not mask output.
        #[arg(long)]
        no_mask: bool,
        /// The command and its arguments, after `--`.
        #[arg(last = true, required = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
    /// Pair, inspect or remove AI agents.
    #[command(subcommand)]
    Agent(AgentCmd),
    /// Update zv to the latest release. The zv inside Zvault.app updates
    /// with the app instead.
    Update {
        /// Only say whether a newer zv exists.
        #[arg(long)]
        check: bool,
    },
}

#[derive(Subcommand)]
enum AgentCmd {
    /// Pair an agent on this machine. Approve it in the app.
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
    /// Act as this paired agent (default: $ZV_AGENT). Without it, commands
    /// run as you and are approved in Zvault.
    #[arg(long)]
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
    #[error("could not read the value: {0}")]
    Input(std::io::Error),
    #[error(transparent)]
    Update(#[from] update::UpdateError),
}

impl Error {
    fn exit_code(&self) -> u8 {
        match self {
            Self::Client(e) => e.exit_code(),
            Self::Cred(CredError::NonePaired | CredError::Unknown(_)) => 3,
            Self::Usage(_) => 64,
            Self::Spawn(_) => 127,
            Self::Cred(_) | Self::Input(_) | Self::Update(_) => 1,
        }
    }
}

fn usage(what: &str, e: impl std::fmt::Display) -> Error {
    Error::Usage(format!("{what}: {e}"))
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

/// Talks to the app as `auth` (an agent) or, with `None`, as the user.
struct Conn {
    socket: PathBuf,
    auth: Option<AgentAuth>,
}

impl Conn {
    fn user() -> Result<Self, Error> {
        Ok(Self {
            socket: paths::socket_path().ok_or(ClientError::NoSocketPath)?,
            auth: None,
        })
    }

    /// The agent named by `--agent` or `ZV_AGENT`, or the user.
    fn acting_as(store_path: &Path, who: &Who) -> Result<Self, Error> {
        let mut conn = Self::user()?;
        let env = std::env::var(AGENT_ENV).ok().filter(|s| !s.is_empty());
        if let Some(name) = who.agent.as_deref().or(env.as_deref()) {
            let store = Store::load(store_path)?;
            conn.auth = Some(store.select(Some(name))?.auth()?);
        }
        Ok(conn)
    }

    fn send(&self, body: RequestBody) -> Result<Response, Error> {
        if self.auth.is_none() && needs_user(&body) && std::io::stderr().is_terminal() {
            eprintln!("zv: approve in Zvault…");
        }
        Ok(client::request(&self.socket, self.auth.clone(), body)?)
    }
}

/// Whether the user may be asked to approve this in the app.
fn needs_user(body: &RequestBody) -> bool {
    !matches!(
        body,
        RequestBody::AppStatus | RequestBody::SignOut | RequestBody::Status | RequestBody::Unpair
    )
}

fn unexpected<T>(_: Response) -> Result<T, Error> {
    Err(ClientError::Unexpected.into())
}

fn parse_ref(s: &str) -> Result<SecretRef, Error> {
    s.parse().map_err(|e| usage(s, e))
}

fn parse_place(s: &str) -> Result<ScopePattern, Error> {
    ScopePattern::parse_place(s).map_err(|e| usage(s, e))
}

fn purpose(kind: PurposeKind, command: &[String]) -> Purpose {
    Purpose {
        kind,
        command: summarize(command),
        cwd: std::env::current_dir()
            .ok()
            .map(|d| d.display().to_string()),
    }
}

fn dispatch(cmd: Cmd) -> Result<u8, Error> {
    let store_path = credentials::default_path()?;
    match cmd {
        Cmd::Status => status(&store_path),
        Cmd::Unlock => {
            if std::io::stderr().is_terminal() {
                eprintln!("zv: unlock Zvault to continue…");
            }
            Conn::user()?.send(RequestBody::Unlock)?;
            println!("Zvault is unlocked.");
            Ok(0)
        }
        Cmd::Signin => {
            Conn::user()?.send(RequestBody::SignIn)?;
            println!(
                "This terminal is signed in for 10 minutes of inactivity (an hour at most), \
                 or until Zvault locks."
            );
            Ok(0)
        }
        Cmd::Signout => {
            Conn::user()?.send(RequestBody::SignOut)?;
            println!("Signed out.");
            Ok(0)
        }
        Cmd::Ls {
            who,
            place,
            recursive,
        } => {
            let prefix = place.as_deref().map(parse_place).transpose()?;
            let conn = Conn::acting_as(&store_path, &who)?;
            let refs = match conn.send(RequestBody::List {
                prefix: prefix.clone(),
            })? {
                Response::List { refs } => refs,
                other => return unexpected(other),
            };
            for line in format::listing(prefix.as_ref(), &refs, recursive) {
                println!("{line}");
            }
            Ok(0)
        }
        Cmd::Read {
            who,
            reference,
            no_newline,
        } => {
            let reference = parse_ref(&reference)?;
            let conn = Conn::acting_as(&store_path, &who)?;
            let values = fetch(&conn, vec![reference], PurposeKind::Read, &[])?;
            let (_, value) = values.into_iter().next().ok_or(ClientError::Unexpected)?;
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(value.as_bytes());
            if !no_newline {
                let _ = out.write_all(b"\n");
            }
            let _ = out.flush();
            Ok(0)
        }
        Cmd::Copy { reference } => {
            let reference = parse_ref(&reference)?;
            match Conn::user()?.send(RequestBody::Copy { reference })? {
                Response::Copied { clear_after_secs } => {
                    println!("Copied. Zvault clears the clipboard in {clear_after_secs} seconds.");
                    Ok(0)
                }
                other => unexpected(other),
            }
        }
        Cmd::Set { reference } => {
            let reference = parse_ref(&reference)?;
            let value = read_value(&format!("Value for {reference}: "))?;
            let shown = reference.to_string();
            match Conn::user()?.send(RequestBody::Set { reference, value })? {
                Response::Ok => {
                    println!("Saved {shown}.");
                    Ok(0)
                }
                other => unexpected(other),
            }
        }
        Cmd::Env { who, place, format } => {
            let prefix = parse_place(&place)?;
            let conn = Conn::acting_as(&store_path, &who)?;
            let values = export(&conn, prefix, &[])?;
            let vars: Vec<(String, &str)> = values
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str()))
                .collect();
            let text = Zeroizing::new(format::env(&vars, format));
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
            Ok(0)
        }
        Cmd::Run {
            who,
            env,
            env_from,
            no_mask,
            command,
        } => {
            let pairs = parse_env_specs(&env)?;
            if pairs.is_empty() && env_from.is_none() {
                return Err(Error::Usage(
                    "give --env NAME=PATH or --env-from PLACE".into(),
                ));
            }
            let prefix = env_from.as_deref().map(parse_place).transpose()?;
            let conn = Conn::acting_as(&store_path, &who)?;

            let mut vars: Vec<(String, Zeroizing<String>)> = match prefix {
                Some(p) => export(&conn, p, &command)?,
                None => vec![],
            };
            if !pairs.is_empty() {
                let refs = pairs.iter().map(|(_, r)| r.clone()).collect();
                let values = fetch(&conn, refs, PurposeKind::Run, &command)?;
                for (key, r) in pairs {
                    let v = values
                        .iter()
                        .find(|(vr, _)| *vr == r)
                        .map(|(_, v)| v.clone())
                        .ok_or(ClientError::Unexpected)?;
                    vars.retain(|(k, _)| *k != key);
                    vars.push((key, v));
                }
            }
            let status = run::run(&command, &vars, !no_mask).map_err(Error::Spawn)?;
            Ok(run::exit_code(status))
        }
        Cmd::Agent(cmd) => agent(&store_path, cmd),
        Cmd::Update { check } => Ok(update::run(check)?),
    }
}

fn status(store_path: &Path) -> Result<u8, Error> {
    let paired = Store::load(store_path).map_or(0, |s| s.agents.len());
    let reply = Conn::user()?.send(RequestBody::AppStatus);
    let (running, locked, signed_in) = match reply {
        Ok(Response::AppStatus {
            locked,
            signed_in_secs,
            ..
        }) => (true, locked, signed_in_secs),
        Err(Error::Client(ClientError::NotRunning(_))) => (false, true, None),
        Err(e) => return Err(e),
        Ok(other) => return unexpected(other),
    };
    println!(
        "Zvault:    {}",
        if running { "running" } else { "not running" }
    );
    if running {
        println!("Vault:     {}", if locked { "locked" } else { "unlocked" });
        match signed_in {
            Some(secs) => println!("Terminal:  signed in ({} min left)", secs.div_ceil(60)),
            None => println!("Terminal:  not signed in (each command asks in Zvault)"),
        }
    }
    println!("Agents:    {paired} paired on this machine");
    Ok(if running { 0 } else { 2 })
}

fn agent(store_path: &Path, cmd: AgentCmd) -> Result<u8, Error> {
    match cmd {
        AgentCmd::Pair { name } => pair(store_path, &name),
        AgentCmd::List => {
            let store = Store::load(store_path)?;
            if store.agents.is_empty() {
                println!("No agents are paired on this machine.");
            }
            for a in &store.agents {
                println!("{}\t{}", a.name, a.agent_id);
            }
            Ok(0)
        }
        AgentCmd::Status { who } => {
            let store = Store::load(store_path)?;
            let agent = store.select(who.agent.as_deref())?;
            let conn = Conn {
                auth: Some(agent.auth()?),
                ..Conn::user()?
            };
            match conn.send(RequestBody::Status)? {
                Response::Status(s) => {
                    print_status(&s);
                    Ok(0)
                }
                other => unexpected(other),
            }
        }
        AgentCmd::Unpair { who } => {
            let mut store = Store::load(store_path)?;
            let agent = store.select(who.agent.as_deref())?.clone();
            let conn = Conn {
                auth: Some(agent.auth()?),
                ..Conn::user()?
            };
            match conn.send(RequestBody::Unpair) {
                // Already gone from the app: still forget it here.
                Ok(_) | Err(Error::Client(ClientError::App { .. })) => {}
                Err(e) => return Err(e),
            }
            store.remove(&agent.agent_id)?;
            store.save(store_path)?;
            println!("Unpaired {}.", agent.name);
            Ok(0)
        }
    }
}

fn pair(store_path: &Path, name: &str) -> Result<u8, Error> {
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
    match Conn::user()?.send(RequestBody::Pair {
        name: name.clone(),
        code,
    })? {
        Response::Paired {
            agent_id,
            name,
            token,
        } => {
            store.add(&name, &agent_id, token)?;
            store.save(store_path)?;
            println!("Paired {name}. Choose which secrets it may use in Zvault > Agents.");
            println!("Have the agent run zv with {AGENT_ENV}=\"{name}\" (or --agent \"{name}\").");
            Ok(0)
        }
        other => unexpected(other),
    }
}

fn parse_env_specs(specs: &[String]) -> Result<Vec<(String, SecretRef)>, Error> {
    let mut pairs: Vec<(String, SecretRef)> = Vec::with_capacity(specs.len());
    for spec in specs {
        let (key, reference) = spec
            .split_once('=')
            .ok_or_else(|| Error::Usage(format!("--env takes NAME=PATH, got {spec:?}")))?;
        if !run::valid_env_name(key) {
            return Err(Error::Usage(format!(
                "{key:?} is not a valid variable name"
            )));
        }
        if pairs.iter().any(|(k, _)| k == key) {
            return Err(Error::Usage(format!("{key} is set twice")));
        }
        pairs.push((key.to_owned(), parse_ref(reference)?));
    }
    Ok(pairs)
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
    conn: &Conn,
    mut refs: Vec<SecretRef>,
    kind: PurposeKind,
    command: &[String],
) -> Result<Vec<(SecretRef, Zeroizing<String>)>, Error> {
    refs.sort();
    refs.dedup();
    match conn.send(RequestBody::Fetch {
        refs,
        purpose: purpose(kind, command),
    })? {
        Response::Secrets { values } => {
            Ok(values.into_iter().map(|v| (v.reference, v.value)).collect())
        }
        other => unexpected(other),
    }
}

/// Every secret under `prefix`, as (variable name, value).
fn export(
    conn: &Conn,
    prefix: ScopePattern,
    command: &[String],
) -> Result<Vec<(String, Zeroizing<String>)>, Error> {
    let kind = if command.is_empty() {
        PurposeKind::Export
    } else {
        PurposeKind::Run
    };
    let values = match conn.send(RequestBody::Export {
        prefix,
        purpose: purpose(kind, command),
    })? {
        Response::Secrets { values } => values,
        other => return unexpected(other),
    };
    let refs: Vec<SecretRef> = values.iter().map(|v| v.reference.clone()).collect();
    let names = format::env_names(&refs).map_err(Error::Usage)?;
    Ok(names
        .into_iter()
        .zip(values)
        .map(|(n, v)| (n, v.value))
        .collect())
}

/// Reads a value for `zv set`: hidden when typed at a terminal, otherwise
/// all of stdin with one trailing newline removed.
fn read_value(prompt: &str) -> Result<Zeroizing<String>, Error> {
    let stdin = std::io::stdin();
    let mut value = Zeroizing::new(String::new());
    if stdin.is_terminal() {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        let _echo_off = EchoOff::new(&stdin);
        stdin.lock().read_line(&mut value).map_err(Error::Input)?;
        eprintln!();
    } else {
        std::io::Read::read_to_string(&mut stdin.lock(), &mut value).map_err(Error::Input)?;
    }
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    if value.is_empty() {
        return Err(Error::Usage("the value is empty".into()));
    }
    Ok(value)
}

/// Turns terminal echo off until dropped.
struct EchoOff {
    saved: Option<nix::sys::termios::Termios>,
}

impl EchoOff {
    fn new(stdin: &std::io::Stdin) -> Self {
        use nix::sys::termios::{LocalFlags, SetArg, tcgetattr, tcsetattr};
        let saved = tcgetattr(stdin).ok();
        if let Some(t) = &saved {
            let mut quiet = t.clone();
            quiet.local_flags.remove(LocalFlags::ECHO);
            quiet.local_flags.insert(LocalFlags::ECHONL);
            let _ = tcsetattr(stdin, SetArg::TCSANOW, &quiet);
        }
        Self { saved }
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        if let Some(t) = &self.saved {
            let _ = nix::sys::termios::tcsetattr(
                std::io::stdin(),
                nix::sys::termios::SetArg::TCSANOW,
                t,
            );
        }
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

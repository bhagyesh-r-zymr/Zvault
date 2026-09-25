//! `zv project`, `zv environment`, `zv folder`, `zv rm` and `zv item`:
//! changing what Zvault holds.
//!
//! Every change runs as you (never as a paired agent), and Zvault asks you to
//! approve each one in the app, even in a signed-in terminal. Deletes also
//! need `--yes` here, so a script cannot delete by accident.

use std::io::Write;

use clap::{Args, Subcommand};
use serde::Serialize;
use zeroize::Zeroizing;
use zvault_agent::manage::{
    self, Change, EnvironmentKind, ItemContents, ItemInfo, ItemPatch, ProjectInfo,
};
use zvault_agent::protocol::{ErrorCode, RequestBody, Response};

use crate::client::ClientError;
use crate::{Conn, Error, Who, read_value, unexpected, usage};

#[derive(Subcommand)]
pub enum ProjectCmd {
    /// List your projects with their environments and folders.
    #[command(visible_alias = "ls")]
    List {
        #[command(flatten)]
        who: Who,
        /// Print JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Create a project. It starts with no environments unless you add some
    /// with --env.
    #[command(
        after_help = "Example:\n  zv project create \"Payments API\" --env Development --env Staging --env Production\n  \
        (creates zv://payments-api with zv://payments-api/development, …/staging and …/production)"
    )]
    Create {
        /// Its name, for example "Payments API".
        name: String,
        /// The slug used in zv:// paths (default: made from the name, like payments-api).
        #[arg(long)]
        slug: Option<String>,
        /// An environment to create with it; repeatable. Development, Staging
        /// and Production get their usual kind.
        #[arg(short, long = "env", value_name = "NAME")]
        env: Vec<String>,
    },
    /// Rename a project or change its slug. Changing the slug changes every
    /// zv:// path in it.
    #[command(
        after_help = "Example:\n  zv project rename zv://payments-api \"Payments\" --slug payments"
    )]
    Rename {
        /// zv://<project>
        project: String,
        /// The new name (leave out to change only the slug).
        name: Option<String>,
        #[arg(long)]
        slug: Option<String>,
    },
    /// Delete a project with every environment, folder and secret in it.
    Delete {
        /// zv://<project>
        project: String,
        /// Confirm the delete. Zvault still asks you to approve it.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum EnvironmentCmd {
    /// List a project's environments.
    #[command(visible_alias = "ls")]
    List {
        #[command(flatten)]
        who: Who,
        /// zv://<project>
        project: String,
        #[arg(long)]
        json: bool,
    },
    /// Add an environment to a project. It gets its own encryption key.
    #[command(
        after_help = "Examples:\n  zv environment create zv://payments-api QA --inherits development\n  \
        zv environment create zv://payments-api \"Preview\" --slug preview --kind custom"
    )]
    Create {
        /// zv://<project>
        project: String,
        /// Its name, for example "Staging".
        name: String,
        /// The slug used in zv:// paths (default: made from the name).
        #[arg(long)]
        slug: Option<String>,
        /// development, staging, production or custom (default: guessed from the name).
        #[arg(long, value_parser = parse_kind)]
        kind: Option<EnvironmentKind>,
        /// Slug of an environment whose value a secret uses when it has none here.
        #[arg(long, value_name = "ENVIRONMENT")]
        inherits: Option<String>,
    },
    /// Rename an environment, change its slug or kind, or what it falls back to.
    #[command(
        visible_alias = "rename",
        after_help = "Examples:\n  zv environment edit zv://payments-api/qa --name \"Quality\" --slug quality\n  \
        zv environment edit zv://payments-api/preview --no-inherit"
    )]
    Edit {
        /// zv://<project>/<environment>
        environment: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        slug: Option<String>,
        #[arg(long, value_parser = parse_kind)]
        kind: Option<EnvironmentKind>,
        /// Fall back to this environment's values.
        #[arg(long, value_name = "ENVIRONMENT", conflicts_with = "no_inherit")]
        inherits: Option<String>,
        /// Stop falling back to another environment.
        #[arg(long)]
        no_inherit: bool,
    },
    /// Delete an environment, its key and every value in it. Secrets that
    /// had a value only there are deleted too.
    Delete {
        /// zv://<project>/<environment>
        environment: String,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum FolderCmd {
    /// List a project's folders.
    #[command(visible_alias = "ls")]
    List {
        #[command(flatten)]
        who: Who,
        /// zv://<project>
        project: String,
        #[arg(long)]
        json: bool,
    },
    /// Add a folder to a project. Folders are one level deep and shared by
    /// all its environments: zv://<project>/<environment>/<folder>/<KEY>.
    #[command(
        after_help = "Example:\n  zv folder create zv://payments-api Stripe\n  \
        printf '%s' \"$KEY\" | zv set zv://payments-api/production/stripe/STRIPE_SECRET_KEY"
    )]
    Create {
        /// zv://<project>
        project: String,
        name: String,
        #[arg(long)]
        slug: Option<String>,
    },
    /// Rename a folder or change its slug.
    Rename {
        /// zv://<project>
        project: String,
        /// The folder's current slug.
        folder: String,
        /// The new name (leave out to change only the slug).
        name: Option<String>,
        #[arg(long)]
        slug: Option<String>,
    },
    /// Delete an empty folder.
    Delete {
        /// zv://<project>
        project: String,
        /// The folder's slug.
        folder: String,
        #[arg(long)]
        yes: bool,
    },
}

/// Where an item's password comes from.
#[derive(Args, Default)]
pub struct PasswordSource {
    /// Read the password from stdin (hidden when typed).
    #[arg(long, conflicts_with = "generate")]
    password_stdin: bool,
    /// Make a random password of this many characters (default 32). It is
    /// saved without being printed.
    #[arg(long, value_name = "LENGTH", num_args = 0..=1, default_missing_value = "32")]
    generate: Option<usize>,
}

#[derive(Args)]
pub struct ItemFieldArgs {
    /// The item's title, for example "GitHub".
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    username: Option<String>,
    /// A website; repeatable. Replaces the item's websites.
    #[arg(long = "url", value_name = "URL")]
    urls: Vec<String>,
    #[arg(long)]
    notes: Option<String>,
    /// A one-time password setup (an otpauth://totp/ URI from the site's QR code).
    #[arg(long, value_name = "URI")]
    totp: Option<String>,
    #[command(flatten)]
    password: PasswordSource,
}

/// Which part of an item `zv item get --field` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ItemField {
    Id,
    Title,
    Username,
    Password,
    Url,
    Notes,
    /// The otpauth:// setup URI.
    Totp,
    /// The current one-time code.
    Otp,
}

#[derive(Subcommand)]
pub enum ItemCmd {
    /// List the items in your vault: titles, usernames and websites, never passwords.
    #[command(visible_alias = "ls")]
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show an item, password included. Zvault asks you to approve it.
    #[command(
        after_help = "Examples:\n  zv item get GitHub --field password | pbcopy\n  zv item get GitHub --field otp\n  zv item get GitHub --json"
    )]
    Get {
        /// The item's title (any case) or id.
        item: String,
        /// Print only this field, with no newline added when piped.
        #[arg(long, value_enum)]
        field: Option<ItemField>,
        #[arg(long, conflicts_with = "field")]
        json: bool,
    },
    /// Add a login to your vault.
    #[command(
        after_help = "Examples:\n  zv item create --title GitHub --username me@example.com --url https://github.com --generate\n  \
        printf '%s' \"$PW\" | zv item create --title Bank --username me --password-stdin"
    )]
    Create {
        #[command(flatten)]
        fields: ItemFieldArgs,
    },
    /// Change an item. Only the fields you give change.
    #[command(
        after_help = "Examples:\n  zv item edit GitHub --generate 40\n  zv item edit GitHub --username new@example.com --url https://github.com"
    )]
    Edit {
        /// The item's title (any case) or id.
        item: String,
        #[command(flatten)]
        fields: ItemFieldArgs,
    },
    /// Delete an item from your vault.
    Delete {
        /// The item's title (any case) or id.
        item: String,
        #[arg(long)]
        yes: bool,
    },
}

fn parse_kind(s: &str) -> Result<EnvironmentKind, String> {
    s.parse()
}

fn project_slug(s: &str) -> Result<String, Error> {
    manage::parse_project(s).map_err(|e| usage(s, e))
}

fn environment_slugs(s: &str) -> Result<(String, String), Error> {
    manage::parse_environment(s).map_err(|e| usage(s, e))
}

fn confirm(yes: bool, what: &str) -> Result<(), Error> {
    if yes {
        Ok(())
    } else {
        Err(Error::Usage(format!(
            "this deletes {what} for good; run it again with --yes (Zvault will still ask you to approve)"
        )))
    }
}

/// Sends a request only newer apps understand, and says so when the app
/// is older.
fn send_new(conn: &Conn, body: RequestBody) -> Result<Response, Error> {
    match conn.send(body) {
        Err(Error::Client(ClientError::App {
            code: ErrorCode::BadRequest,
            ..
        })) => Err(Error::Client(ClientError::App {
            code: ErrorCode::BadRequest,
            message: "the running Zvault app does not know this command; update Zvault (Settings > About) and try again".into(),
        })),
        other => other,
    }
}

/// Asks Zvault to make `change` and prints what it did.
pub fn change(change: Change) -> Result<u8, Error> {
    change.validate().map_err(Error::Usage)?;
    match send_new(&Conn::user()?, RequestBody::Change { change })? {
        Response::Changed { message } => {
            println!("{message}");
            Ok(0)
        }
        other => unexpected(other),
    }
}

/// Every project with its environments and folders, as Zvault reports them.
pub fn structure(conn: &Conn) -> Result<Vec<ProjectInfo>, Error> {
    match send_new(conn, RequestBody::Structure)? {
        Response::Structure { projects } => Ok(projects),
        other => unexpected(other),
    }
}

fn print_json<T: Serialize + ?Sized>(value: &T) {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    println!("{text}");
}

fn find_project<'a>(projects: &'a [ProjectInfo], slug: &str) -> Result<&'a ProjectInfo, Error> {
    projects.iter().find(|p| p.slug == slug).ok_or_else(|| {
        Error::Client(ClientError::App {
            code: ErrorCode::NotFound,
            message: format!("there is no project zv://{slug} (or you may not see it)"),
        })
    })
}

/// `zv projects`: each project, then its environments and folders.
pub fn list_projects(conn: &Conn, json: bool) -> Result<u8, Error> {
    let projects = structure(conn)?;
    if json {
        print_json(&projects);
        return Ok(0);
    }
    if projects.is_empty() {
        println!(
            "No projects yet. Create one with: zv project create \"My project\" --env Development"
        );
    }
    for p in &projects {
        println!(
            "zv://{}\t{}{}",
            p.slug,
            p.name,
            if p.owner { "" } else { " (shared)" }
        );
        for e in &p.environments {
            println!("  {}", environment_line(&p.slug, e));
        }
        if !p.folders.is_empty() {
            let folders: Vec<&str> = p.folders.iter().map(|f| f.slug.as_str()).collect();
            println!("  folders: {}", folders.join(", "));
        }
    }
    Ok(0)
}

fn environment_line(project: &str, e: &manage::EnvironmentInfo) -> String {
    let mut line = format!("zv://{project}/{}\t{} ({})", e.slug, e.name, e.kind);
    if let Some(from) = &e.inherits_from {
        line.push_str(&format!(", falls back to {from}"));
    }
    if e.locked {
        line.push_str(", no access to values");
    }
    line
}

pub fn project(cmd: ProjectCmd, store_path: &std::path::Path) -> Result<u8, Error> {
    match cmd {
        ProjectCmd::List { who, json } => list_projects(&Conn::acting_as(store_path, &who)?, json),
        ProjectCmd::Create { name, slug, env } => change(Change::CreateProject {
            name,
            slug,
            environments: env,
        }),
        ProjectCmd::Rename {
            project,
            name,
            slug,
        } => change(Change::UpdateProject {
            project: project_slug(&project)?,
            name,
            slug,
        }),
        ProjectCmd::Delete { project, yes } => {
            let project = project_slug(&project)?;
            confirm(yes, &format!("zv://{project} and every secret in it"))?;
            change(Change::DeleteProject { project })
        }
    }
}

pub fn environment(cmd: EnvironmentCmd, store_path: &std::path::Path) -> Result<u8, Error> {
    match cmd {
        EnvironmentCmd::List { who, project, json } => {
            let slug = project_slug(&project)?;
            let projects = structure(&Conn::acting_as(store_path, &who)?)?;
            let p = find_project(&projects, &slug)?;
            if json {
                print_json(&p.environments);
            } else if p.environments.is_empty() {
                println!(
                    "zv://{slug} has no environments yet. Add one with: zv environment create zv://{slug} Development"
                );
            } else {
                for e in &p.environments {
                    println!("{}", environment_line(&slug, e));
                }
            }
            Ok(0)
        }
        EnvironmentCmd::Create {
            project,
            name,
            slug,
            kind,
            inherits,
        } => change(Change::CreateEnvironment {
            project: project_slug(&project)?,
            name,
            slug,
            kind,
            inherits_from: inherits,
        }),
        EnvironmentCmd::Edit {
            environment,
            name,
            slug,
            kind,
            inherits,
            no_inherit,
        } => {
            let (project, environment) = environment_slugs(&environment)?;
            change(Change::UpdateEnvironment {
                project,
                environment,
                name,
                slug,
                kind,
                inherits_from: inherits,
                no_fallback: no_inherit,
            })
        }
        EnvironmentCmd::Delete { environment, yes } => {
            let (project, environment) = environment_slugs(&environment)?;
            confirm(
                yes,
                &format!("zv://{project}/{environment} and every value in it"),
            )?;
            change(Change::DeleteEnvironment {
                project,
                environment,
            })
        }
    }
}

pub fn folder(cmd: FolderCmd, store_path: &std::path::Path) -> Result<u8, Error> {
    match cmd {
        FolderCmd::List { who, project, json } => {
            let slug = project_slug(&project)?;
            let projects = structure(&Conn::acting_as(store_path, &who)?)?;
            let p = find_project(&projects, &slug)?;
            if json {
                print_json(&p.folders);
            } else if p.folders.is_empty() {
                println!("zv://{slug} has no folders.");
            } else {
                for f in &p.folders {
                    println!("{}\t{}", f.slug, f.name);
                }
            }
            Ok(0)
        }
        FolderCmd::Create {
            project,
            name,
            slug,
        } => change(Change::CreateFolder {
            project: project_slug(&project)?,
            name,
            slug,
        }),
        FolderCmd::Rename {
            project,
            folder,
            name,
            slug,
        } => change(Change::UpdateFolder {
            project: project_slug(&project)?,
            folder,
            name,
            slug,
        }),
        FolderCmd::Delete {
            project,
            folder,
            yes,
        } => {
            let project = project_slug(&project)?;
            confirm(yes, &format!("the folder {folder} in zv://{project}"))?;
            change(Change::DeleteFolder { project, folder })
        }
    }
}

// ---------------------------------------------------------------------------
// Items

fn password(source: &PasswordSource, prompt: &str) -> Result<Option<Zeroizing<String>>, Error> {
    if let Some(len) = source.generate {
        if !(manage::MIN_GENERATED..=manage::MAX_GENERATED).contains(&len) {
            return Err(Error::Usage(format!(
                "--generate takes a length from {} to {}",
                manage::MIN_GENERATED,
                manage::MAX_GENERATED
            )));
        }
        return Ok(Some(manage::generate_password(len)));
    }
    if source.password_stdin {
        return read_value(prompt).map(Some);
    }
    Ok(None)
}

fn patch(fields: ItemFieldArgs) -> Result<ItemPatch, Error> {
    let password = password(&fields.password, "Password: ")?;
    Ok(ItemPatch {
        title: fields.title,
        username: fields.username,
        password,
        urls: (!fields.urls.is_empty()).then_some(fields.urls),
        notes: fields.notes.map(Zeroizing::new),
        totp: fields.totp.map(Zeroizing::new),
    })
}

fn item_put(item: Option<String>, patch: ItemPatch) -> Result<u8, Error> {
    patch.validate(item.is_none()).map_err(Error::Usage)?;
    match send_new(&Conn::user()?, RequestBody::ItemPut { item, patch })? {
        Response::Changed { message } => {
            println!("{message}");
            Ok(0)
        }
        other => unexpected(other),
    }
}

pub fn item(cmd: ItemCmd) -> Result<u8, Error> {
    match cmd {
        ItemCmd::List { json } => {
            let items: Vec<ItemInfo> = match send_new(&Conn::user()?, RequestBody::Items)? {
                Response::Items { items } => items,
                other => return unexpected(other),
            };
            if json {
                print_json(&items);
            } else if items.is_empty() {
                println!(
                    "Your vault is empty. Add a login with: zv item create --title NAME --generate"
                );
            } else {
                for i in &items {
                    let mut line = format!("{}\t{}", i.id, i.title);
                    if !i.username.is_empty() {
                        line.push_str(&format!("\t{}", i.username));
                    }
                    if let Some(url) = &i.url {
                        line.push_str(&format!("\t{url}"));
                    }
                    if i.has_totp {
                        line.push_str("\t[2FA]");
                    }
                    println!("{line}");
                }
            }
            Ok(0)
        }
        ItemCmd::Get { item, field, json } => {
            let contents = match send_new(&Conn::user()?, RequestBody::ItemGet { item })? {
                Response::Item(c) => c,
                other => return unexpected(other),
            };
            if json {
                print_json(&contents);
            } else if let Some(field) = field {
                print_field(&contents, field)?;
            } else {
                print_item(&contents);
            }
            Ok(0)
        }
        ItemCmd::Create { fields } => item_put(None, patch(fields)?),
        ItemCmd::Edit { item, fields } => item_put(Some(item), patch(fields)?),
        ItemCmd::Delete { item, yes } => {
            confirm(yes, &format!("the item “{item}”"))?;
            match send_new(&Conn::user()?, RequestBody::ItemDelete { item })? {
                Response::Changed { message } => {
                    println!("{message}");
                    Ok(0)
                }
                other => unexpected(other),
            }
        }
    }
}

fn print_field(c: &ItemContents, field: ItemField) -> Result<(), Error> {
    let value: &str = match field {
        ItemField::Id => &c.id,
        ItemField::Title => &c.title,
        ItemField::Username => &c.username,
        ItemField::Password => &c.password,
        ItemField::Url => c.urls.first().map_or("", String::as_str),
        ItemField::Notes => &c.notes,
        ItemField::Totp => &c.totp,
        ItemField::Otp => c
            .otp
            .as_deref()
            .ok_or_else(|| Error::Usage("this item has no one-time password".into()))?,
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(value.as_bytes());
    if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        let _ = out.write_all(b"\n");
    }
    let _ = out.flush();
    Ok(())
}

fn print_item(c: &ItemContents) {
    println!("Title:     {}", c.title);
    println!("Id:        {}", c.id);
    println!("Username:  {}", c.username);
    println!("Password:  {}", c.password.as_str());
    for url in &c.urls {
        println!("Website:   {url}");
    }
    if let Some(otp) = &c.otp {
        println!("One-time:  {otp}");
    }
    if !c.notes.is_empty() {
        println!("Notes:     {}", c.notes.as_str());
    }
}

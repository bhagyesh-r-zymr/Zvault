//! Changing what Zvault holds from `zv`: projects, environments, folders,
//! secrets and the items in the personal vault.
//!
//! These travel over the same socket as reads. The app decides every one of
//! them the same way: only the user may make them (never a paired agent), the
//! app always asks for approval, and it describes the change in its prompt
//! from [`Change::describe`], not from anything the CLI claims. Keys stay in
//! the app: projects and environments are sealed there, and item passwords
//! are sealed and opened in its Rust core.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::reference::{RefError, SCHEME, ScopePattern, SecretRef, slug};

const MAX_PROJECT_NAME: usize = 100;
const MAX_NAME: usize = 64;
const MAX_TITLE: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlaceError {
    #[error("name a project as zv://<project>, for example zv://payments-api")]
    Project,
    #[error(
        "name an environment as zv://<project>/<environment>, for example zv://payments-api/staging"
    )]
    Environment,
    #[error(transparent)]
    Ref(#[from] RefError),
}

fn segments(s: &str) -> Result<Vec<&str>, RefError> {
    let rest = s.strip_prefix(SCHEME).ok_or(RefError::Scheme)?;
    Ok(rest.trim_end_matches('/').split('/').collect())
}

/// `zv://project` (a trailing `/` is fine) to its slug.
pub fn parse_project(s: &str) -> Result<String, PlaceError> {
    match segments(s)?.as_slice() {
        [p] => Ok(slug(p)?),
        _ => Err(PlaceError::Project),
    }
}

/// `zv://project/environment` to its two slugs.
pub fn parse_environment(s: &str) -> Result<(String, String), PlaceError> {
    match segments(s)?.as_slice() {
        [p, e] => Ok((slug(p)?, slug(e)?)),
        _ => Err(PlaceError::Environment),
    }
}

/// Matches `EnvironmentKind` in `@zvault/shared`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentKind {
    Development,
    Staging,
    Production,
    Custom,
}

impl EnvironmentKind {
    pub const ALL: [Self; 4] = [
        Self::Development,
        Self::Staging,
        Self::Production,
        Self::Custom,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Staging => "staging",
            Self::Production => "production",
            Self::Custom => "custom",
        }
    }
}

impl fmt::Display for EnvironmentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for EnvironmentKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| "use development, staging, production or custom".into())
    }
}

/// One change to projects, environments, folders or secrets.
///
/// Projects, environments and folders are named by slug, the way they appear
/// in `zv://` paths. New slugs are made from the name unless one is given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    CreateProject {
        name: String,
        #[serde(default)]
        slug: Option<String>,
        /// Names of environments to create with it, in order.
        #[serde(default)]
        environments: Vec<String>,
    },
    UpdateProject {
        project: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        slug: Option<String>,
    },
    /// Deletes the project with every environment, folder and secret in it.
    DeleteProject { project: String },
    CreateEnvironment {
        project: String,
        name: String,
        #[serde(default)]
        slug: Option<String>,
        #[serde(default)]
        kind: Option<EnvironmentKind>,
        /// Slug of the environment whose values it falls back to.
        #[serde(default)]
        inherits_from: Option<String>,
    },
    UpdateEnvironment {
        project: String,
        environment: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        slug: Option<String>,
        #[serde(default)]
        kind: Option<EnvironmentKind>,
        #[serde(default)]
        inherits_from: Option<String>,
        /// Stop falling back to another environment.
        #[serde(default)]
        no_fallback: bool,
    },
    /// Deletes the environment, its key and every value in it.
    DeleteEnvironment {
        project: String,
        environment: String,
    },
    CreateFolder {
        project: String,
        name: String,
        #[serde(default)]
        slug: Option<String>,
    },
    UpdateFolder {
        project: String,
        folder: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        slug: Option<String>,
    },
    /// Deletes an empty folder.
    DeleteFolder { project: String, folder: String },
    /// Removes a secret's value in the path's environment, or with
    /// `all_environments` the whole secret. A secret left with no value
    /// anywhere is deleted.
    DeleteSecret {
        reference: SecretRef,
        #[serde(default)]
        all_environments: bool,
    },
}

fn check_name(what: &str, name: &str, max: usize) -> Result<(), String> {
    let n = name.trim().chars().count();
    if n == 0 {
        return Err(format!("the {what} name is empty"));
    }
    if n > max {
        return Err(format!("the {what} name is longer than {max} characters"));
    }
    Ok(())
}

fn check_slug(s: &str) -> Result<(), String> {
    slug(s).map(|_| ()).map_err(|e| format!("{s:?}: {e}"))
}

fn check_opt_slug(s: Option<&String>) -> Result<(), String> {
    s.map_or(Ok(()), |s| check_slug(s))
}

impl Change {
    /// Rejects what the app would refuse anyway, with a message for the CLI.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::CreateProject {
                name,
                slug,
                environments,
            } => {
                check_name("project", name, MAX_PROJECT_NAME)?;
                check_opt_slug(slug.as_ref())?;
                for e in environments {
                    check_name("environment", e, MAX_NAME)?;
                }
                Ok(())
            }
            Self::UpdateProject {
                project,
                name,
                slug,
            } => {
                check_slug(project)?;
                if name.is_none() && slug.is_none() {
                    return Err("give a new name or --slug".into());
                }
                if let Some(n) = name {
                    check_name("project", n, MAX_PROJECT_NAME)?;
                }
                check_opt_slug(slug.as_ref())
            }
            Self::DeleteProject { project } => check_slug(project),
            Self::CreateEnvironment {
                project,
                name,
                slug,
                inherits_from,
                ..
            } => {
                check_slug(project)?;
                check_name("environment", name, MAX_NAME)?;
                check_opt_slug(slug.as_ref())?;
                check_opt_slug(inherits_from.as_ref())
            }
            Self::UpdateEnvironment {
                project,
                environment,
                name,
                slug,
                kind,
                inherits_from,
                no_fallback,
            } => {
                check_slug(project)?;
                check_slug(environment)?;
                if let Some(n) = name {
                    check_name("environment", n, MAX_NAME)?;
                }
                check_opt_slug(slug.as_ref())?;
                check_opt_slug(inherits_from.as_ref())?;
                if inherits_from.is_some() && *no_fallback {
                    return Err("give --inherits or --no-inherit, not both".into());
                }
                if inherits_from.as_deref() == Some(environment) {
                    return Err("an environment cannot fall back to itself".into());
                }
                if name.is_none()
                    && slug.is_none()
                    && kind.is_none()
                    && inherits_from.is_none()
                    && !no_fallback
                {
                    return Err("nothing to change; see zv environment edit --help".into());
                }
                Ok(())
            }
            Self::DeleteEnvironment {
                project,
                environment,
            } => {
                check_slug(project)?;
                check_slug(environment)
            }
            Self::CreateFolder {
                project,
                name,
                slug,
            } => {
                check_slug(project)?;
                check_name("folder", name, MAX_NAME)?;
                check_opt_slug(slug.as_ref())
            }
            Self::UpdateFolder {
                project,
                folder,
                name,
                slug,
            } => {
                check_slug(project)?;
                check_slug(folder)?;
                if name.is_none() && slug.is_none() {
                    return Err("give a new name or --slug".into());
                }
                if let Some(n) = name {
                    check_name("folder", n, MAX_NAME)?;
                }
                check_opt_slug(slug.as_ref())
            }
            Self::DeleteFolder { project, folder } => {
                check_slug(project)?;
                check_slug(folder)
            }
            Self::DeleteSecret { .. } => Ok(()),
        }
    }

    /// Whether it deletes something for good. A deleted secret goes to the
    /// Trash and a cleared value stays in the secret's History, so neither is.
    pub fn destructive(&self) -> bool {
        matches!(
            self,
            Self::DeleteProject { .. } | Self::DeleteEnvironment { .. } | Self::DeleteFolder { .. }
        )
    }

    /// One line for the approval prompt and the activity log.
    pub fn describe(&self) -> String {
        match self {
            Self::CreateProject {
                name,
                slug,
                environments,
            } => {
                let mut s = format!("Create project “{}”", name.trim());
                if let Some(slug) = slug {
                    s.push_str(&format!(" as {SCHEME}{slug}"));
                }
                if !environments.is_empty() {
                    s.push_str(&format!(" with {}", environments.join(", ")));
                }
                s
            }
            Self::UpdateProject {
                project,
                name,
                slug,
            } => renamed(&format!("project {SCHEME}{project}"), name, slug),
            Self::DeleteProject { project } => {
                format!("Delete project {SCHEME}{project} with all its environments and secrets")
            }
            Self::CreateEnvironment {
                project,
                name,
                inherits_from,
                ..
            } => {
                let mut s = format!("Create environment “{}” in {SCHEME}{project}", name.trim());
                if let Some(from) = inherits_from {
                    s.push_str(&format!(", falling back to {from}"));
                }
                s
            }
            Self::UpdateEnvironment {
                project,
                environment,
                name,
                slug,
                kind,
                inherits_from,
                no_fallback,
            } => {
                let mut s = renamed(
                    &format!("environment {SCHEME}{project}/{environment}"),
                    name,
                    slug,
                );
                if let Some(k) = kind {
                    s.push_str(&format!(", kind {k}"));
                }
                if let Some(from) = inherits_from {
                    s.push_str(&format!(", falls back to {from}"));
                }
                if *no_fallback {
                    s.push_str(", no fallback");
                }
                s
            }
            Self::DeleteEnvironment {
                project,
                environment,
            } => {
                format!("Delete environment {SCHEME}{project}/{environment} and every value in it")
            }
            Self::CreateFolder { project, name, .. } => {
                format!("Create folder “{}” in {SCHEME}{project}", name.trim())
            }
            Self::UpdateFolder {
                project,
                folder,
                name,
                slug,
            } => renamed(&format!("folder {folder} in {SCHEME}{project}"), name, slug),
            Self::DeleteFolder { project, folder } => {
                format!("Delete the empty folder {folder} in {SCHEME}{project}")
            }
            Self::DeleteSecret {
                reference,
                all_environments: false,
            } => format!("Delete the value of {reference} (the old value stays in History)"),
            Self::DeleteSecret {
                reference,
                all_environments: true,
            } => format!(
                "Move {} in {SCHEME}{} to Trash (restorable for 30 days)",
                reference.key, reference.project
            ),
        }
    }
}

fn renamed(what: &str, name: &Option<String>, slug: &Option<String>) -> String {
    let mut s = format!("Change {what}");
    if let Some(n) = name {
        s.push_str(&format!(": name “{}”", n.trim()));
    }
    if let Some(slug) = slug {
        s.push_str(&format!(
            "{} slug {slug}",
            if name.is_some() { "," } else { ":" }
        ));
    }
    s
}

// ---------------------------------------------------------------------------
// Structure: projects, environments and folders by name

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub slug: String,
    pub name: String,
    /// Whether this account owns it.
    #[serde(default)]
    pub owner: bool,
    #[serde(default)]
    pub environments: Vec<EnvironmentInfo>,
    #[serde(default)]
    pub folders: Vec<FolderInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub slug: String,
    pub name: String,
    pub kind: EnvironmentKind,
    /// Slug of the environment it falls back to.
    #[serde(default)]
    pub inherits_from: Option<String>,
    /// This account holds no key for it, so it can't read or write values.
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub slug: String,
    pub name: String,
}

/// What of `projects` an agent limited to `scopes` may see: projects,
/// environments and folders that some scope reaches into.
pub fn visible(projects: Vec<ProjectInfo>, scopes: &[ScopePattern]) -> Vec<ProjectInfo> {
    // Each scope as (project, environment, folder) slugs, and whether it
    // covers everything below them.
    let places: Vec<(Vec<&str>, bool)> = scopes
        .iter()
        .map(|s| match s {
            ScopePattern::Exact(r) => (r.places(), false),
            ScopePattern::Prefix(p) => (p.iter().map(String::as_str).collect(), true),
        })
        .collect();
    projects
        .into_iter()
        .filter_map(|mut p| {
            let mine: Vec<&(Vec<&str>, bool)> =
                places.iter().filter(|(s, _)| s[0] == p.slug).collect();
            if mine.is_empty() {
                return None;
            }
            p.environments
                .retain(|e| mine.iter().any(|(s, _)| s.len() == 1 || s[1] == e.slug));
            p.folders.retain(|f| {
                mine.iter().any(|(s, prefix)| {
                    (*prefix && s.len() < 3) || s.get(2) == Some(&f.slug.as_str())
                })
            });
            Some(p)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Generated values

/// Characters of a generated value: letters, digits and symbols that need no
/// quoting in `.env` files or URLs.
const PASSWORD_CHARS: &[u8] =
    b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.~!@%^*+=";
pub const MIN_GENERATED: usize = 12;
pub const MAX_GENERATED: usize = 256;

/// A random value of `len` characters from the OS generator, for `zv set
/// --generate` and `zv item create --generate`, so an agent never has to
/// see or invent one.
pub fn generate_password(len: usize) -> Zeroizing<String> {
    let len = len.clamp(MIN_GENERATED, MAX_GENERATED);
    let n = PASSWORD_CHARS.len();
    // Rejection sampling keeps every character equally likely.
    let limit = 256 - (256 % n);
    let mut out = Zeroizing::new(String::with_capacity(len));
    let mut buf = Zeroizing::new([0u8; 64]);
    while out.len() < len {
        getrandom::fill(&mut buf[..]).expect("OS random number generator failed");
        for &b in buf.iter() {
            if usize::from(b) < limit && out.len() < len {
                out.push(char::from(PASSWORD_CHARS[usize::from(b) % n]));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Vault items

/// An item in the list: never its password, notes or one-time password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub has_totp: bool,
}

/// An item's contents, as `zv item get` prints them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemContents {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: Zeroizing<String>,
    pub urls: Vec<String>,
    pub notes: Zeroizing<String>,
    /// The `otpauth://` setup URI, or empty.
    pub totp: Zeroizing<String>,
    /// The current one-time password, when the item has one.
    #[serde(default)]
    pub otp: Option<String>,
}

/// Fields to set on a new or existing item; `None` keeps what is there.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<Zeroizing<String>>,
    #[serde(default)]
    pub urls: Option<Vec<String>>,
    #[serde(default)]
    pub notes: Option<Zeroizing<String>>,
    #[serde(default)]
    pub totp: Option<Zeroizing<String>>,
}

impl ItemPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.username.is_none()
            && self.password.is_none()
            && self.urls.is_none()
            && self.notes.is_none()
            && self.totp.is_none()
    }

    pub fn validate(&self, creating: bool) -> Result<(), String> {
        match &self.title {
            Some(t) => check_name("item", t, MAX_TITLE)?,
            None if creating => return Err("a new item needs --title".into()),
            None => {}
        }
        if !creating && self.is_empty() {
            return Err("nothing to change; see zv item edit --help".into());
        }
        if let Some(t) = &self.totp
            && !t.is_empty()
            && !t.starts_with("otpauth://totp/")
        {
            return Err("--totp takes an otpauth://totp/ URI".into());
        }
        Ok(())
    }

    /// The fields it sets, for the approval prompt. Never values.
    pub fn field_names(&self) -> Vec<&'static str> {
        let mut out = vec![];
        for (set, name) in [
            (self.title.is_some(), "title"),
            (self.username.is_some(), "username"),
            (self.password.is_some(), "password"),
            (self.urls.is_some(), "website"),
            (self.notes.is_some(), "notes"),
            (self.totp.is_some(), "one-time password"),
        ] {
            if set {
                out.push(name);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_and_environment_places() {
        assert_eq!(parse_project("zv://web").unwrap(), "web");
        assert_eq!(parse_project("zv://web/").unwrap(), "web");
        assert_eq!(parse_project("zv://web/dev"), Err(PlaceError::Project));
        assert!(parse_project("web").is_err());
        assert!(parse_project("zv://Web").is_err());
        assert_eq!(
            parse_environment("zv://web/dev").unwrap(),
            ("web".into(), "dev".into())
        );
        assert_eq!(parse_environment("zv://web"), Err(PlaceError::Environment));
    }

    #[test]
    fn changes_round_trip_and_describe_themselves() {
        let c = Change::UpdateEnvironment {
            project: "web".into(),
            environment: "qa".into(),
            name: Some("QA".into()),
            slug: None,
            kind: Some(EnvironmentKind::Staging),
            inherits_from: Some("development".into()),
            no_fallback: false,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""op":"updateEnvironment""#), "{json}");
        assert!(json.contains(r#""inheritsFrom":"development""#), "{json}");
        let back: Change = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
        assert_eq!(
            c.describe(),
            "Change environment zv://web/qa: name “QA”, kind staging, falls back to development"
        );
        assert!(!c.destructive());
        let del = Change::DeleteProject {
            project: "web".into(),
        };
        assert!(del.destructive());
        assert!(del.describe().contains("zv://web"));
        let trashed = Change::DeleteSecret {
            reference: "zv://web/dev/API_KEY".parse().unwrap(),
            all_environments: true,
        };
        assert!(!trashed.destructive());
        assert!(trashed.describe().contains("Trash"));
    }

    #[test]
    fn validation_catches_what_the_app_would_refuse() {
        let empty = Change::UpdateProject {
            project: "web".into(),
            name: None,
            slug: None,
        };
        assert!(empty.validate().is_err());
        let bad_slug = Change::CreateProject {
            name: "Web".into(),
            slug: Some("Not A Slug".into()),
            environments: vec![],
        };
        assert!(bad_slug.validate().is_err());
        let both = Change::UpdateEnvironment {
            project: "web".into(),
            environment: "qa".into(),
            name: None,
            slug: None,
            kind: None,
            inherits_from: Some("dev".into()),
            no_fallback: true,
        };
        assert!(both.validate().is_err());
        let ok = Change::CreateProject {
            name: "Payments API".into(),
            slug: None,
            environments: vec!["Development".into(), "Production".into()],
        };
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn agents_see_only_the_structure_their_scopes_reach() {
        let env = |slug: &str| EnvironmentInfo {
            slug: slug.into(),
            name: slug.into(),
            kind: EnvironmentKind::Custom,
            inherits_from: None,
            locked: false,
        };
        let folder = |slug: &str| FolderInfo {
            slug: slug.into(),
            name: slug.into(),
        };
        let projects = vec![
            ProjectInfo {
                slug: "web".into(),
                name: "Web".into(),
                owner: true,
                environments: vec![env("dev"), env("prod")],
                folders: vec![folder("stripe"), folder("db")],
            },
            ProjectInfo {
                slug: "ops".into(),
                name: "Ops".into(),
                owner: true,
                environments: vec![env("dev")],
                folders: vec![],
            },
        ];
        let scopes: Vec<ScopePattern> = vec![
            "zv://web/dev/stripe/*".parse().unwrap(),
            "zv://web/dev/API_KEY".parse().unwrap(),
        ];
        let seen = visible(projects, &scopes);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].environments, vec![env("dev")]);
        // The exact path names a secret outside any folder, so it shows none.
        assert_eq!(seen[0].folders, vec![folder("stripe")]);
    }

    #[test]
    fn generated_values_are_long_and_varied() {
        let a = generate_password(32);
        let b = generate_password(32);
        assert_eq!(a.len(), 32);
        assert_ne!(*a, *b);
        assert!(a.bytes().all(|c| PASSWORD_CHARS.contains(&c)));
        assert_eq!(generate_password(1).len(), MIN_GENERATED);
        assert_eq!(generate_password(10_000).len(), MAX_GENERATED);
    }

    #[test]
    fn item_patches_are_checked() {
        assert!(ItemPatch::default().validate(true).is_err());
        assert!(ItemPatch::default().validate(false).is_err());
        let p = ItemPatch {
            title: Some("GitHub".into()),
            totp: Some(Zeroizing::new("nope".into())),
            ..ItemPatch::default()
        };
        assert!(p.validate(true).is_err());
        let p = ItemPatch {
            password: Some(Zeroizing::new("x".into())),
            ..ItemPatch::default()
        };
        assert!(p.validate(false).is_ok());
        assert_eq!(p.field_names(), ["password"]);
    }
}

//! `zv://` secret paths and the scope patterns that allow them.
//!
//! A path names one secret's value in one environment of one project:
//!
//! ```text
//! zv://<project>/<environment>/[<folder>/]<KEY>
//! ```
//!
//! This is the format of `parseSecretPath` in `@zvault/shared` (projects.ts);
//! keep the two in step. Project, environment and folder are slugs
//! (lowercase letters, digits and single dashes, at most 64). `KEY` is the
//! secret's variable name (`[A-Za-z_][A-Za-z0-9_]*`, at most 128), which is
//! also what `zv run` and `zv env` export it as. Folders are one level deep,
//! so three segments mean no folder and four mean a folder.
//!
//! A scope pattern is either a path (one secret) or a place ending in `/*`,
//! which covers everything below it: `zv://web/*`, `zv://web/dev/*`,
//! `zv://web/dev/payments/*`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const SCHEME: &str = "zv://";
const MAX_SLUG: usize = 64;
const MAX_KEY: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RefError {
    #[error("a secret path starts with zv://")]
    Scheme,
    #[error("a secret path is zv://project/environment/[folder/]KEY")]
    Shape,
    #[error("project, environment and folder names are lowercase letters, digits and dashes")]
    Slug,
    #[error("the last part of a secret path is its variable name, like STRIPE_SECRET_KEY")]
    Key,
}

/// Matches `Slug` in `@zvault/shared`.
fn slug(s: &str) -> Result<String, RefError> {
    let ok = !s.is_empty()
        && s.len() <= MAX_SLUG
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(s.to_owned())
    } else {
        Err(RefError::Slug)
    }
}

/// Matches `SecretKeyName` in `@zvault/shared`.
pub fn valid_key(s: &str) -> bool {
    let mut bytes = s.bytes();
    s.len() <= MAX_KEY
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A parsed `zv://` path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SecretRef {
    pub project: String,
    pub environment: String,
    pub folder: Option<String>,
    /// The variable name, case preserved.
    pub key: String,
}

impl SecretRef {
    /// The environment variable `zv env` and `zv run --env-from` use.
    pub fn env_name(&self) -> &str {
        &self.key
    }

    /// Project, environment and folder, in order.
    pub fn places(&self) -> Vec<&str> {
        let mut p = vec![self.project.as_str(), self.environment.as_str()];
        if let Some(f) = &self.folder {
            p.push(f);
        }
        p
    }
}

impl FromStr for SecretRef {
    type Err = RefError;

    fn from_str(s: &str) -> Result<Self, RefError> {
        let rest = s.strip_prefix(SCHEME).ok_or(RefError::Scheme)?;
        let parts: Vec<&str> = rest.split('/').collect();
        let (project, environment, folder, key) = match parts.as_slice() {
            [p, e, k] => (p, e, None, k),
            [p, e, f, k] => (p, e, Some(f), k),
            _ => return Err(RefError::Shape),
        };
        if !valid_key(key) {
            return Err(RefError::Key);
        }
        Ok(Self {
            project: slug(project)?,
            environment: slug(environment)?,
            folder: folder.map(|f| slug(f)).transpose()?,
            key: (*key).to_owned(),
        })
    }
}

impl fmt::Display for SecretRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{SCHEME}")?;
        for place in self.places() {
            write!(f, "{place}/")?;
        }
        f.write_str(&self.key)
    }
}

/// What an agent may read, or a place to list.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ScopePattern {
    /// One secret.
    Exact(SecretRef),
    /// Everything under 1 to 3 slugs (project, environment, folder).
    Prefix(Vec<String>),
}

impl ScopePattern {
    pub fn allows(&self, r: &SecretRef) -> bool {
        match self {
            Self::Exact(p) => p == r,
            Self::Prefix(prefix) => {
                let places = r.places();
                prefix.len() <= places.len() && places.iter().zip(prefix).all(|(a, b)| *a == b)
            }
        }
    }

    /// Parses what a person types to name a place: `zv://web`,
    /// `zv://web/dev`, or a folder with a trailing `/` or `/*`
    /// (`zv://web/dev/payments/`). A full path names that one secret.
    pub fn parse_place(s: &str) -> Result<Self, RefError> {
        let trimmed = s.trim_end_matches("/*").trim_end_matches('/');
        let depth = trimmed
            .strip_prefix(SCHEME)
            .ok_or(RefError::Scheme)?
            .split('/')
            .count();
        if depth <= 2 || s.ends_with('/') || s.ends_with("/*") {
            format!("{trimmed}/*").parse()
        } else {
            trimmed.parse().map(Self::Exact)
        }
    }
}

impl FromStr for ScopePattern {
    type Err = RefError;

    fn from_str(s: &str) -> Result<Self, RefError> {
        let Some(prefix) = s.strip_suffix("/*") else {
            return s.parse().map(Self::Exact);
        };
        let rest = prefix.strip_prefix(SCHEME).ok_or(RefError::Scheme)?;
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() > 3 {
            return Err(RefError::Shape);
        }
        parts
            .into_iter()
            .map(slug)
            .collect::<Result<_, _>>()
            .map(Self::Prefix)
    }
}

impl fmt::Display for ScopePattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exact(r) => r.fmt(f),
            Self::Prefix(p) => write!(f, "{SCHEME}{}/*", p.join("/")),
        }
    }
}

macro_rules! string_serde {
    ($t:ty) => {
        impl Serialize for $t {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_str(self)
            }
        }
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                s.parse().map_err(serde::de::Error::custom)
            }
        }
    };
}
string_serde!(SecretRef);
string_serde!(ScopePattern);

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> SecretRef {
        s.parse().unwrap()
    }

    fn p(s: &str) -> ScopePattern {
        s.parse().unwrap()
    }

    #[test]
    fn parses_with_and_without_folder() {
        let a = r("zv://web/production/STRIPE_KEY");
        assert_eq!(a.project, "web");
        assert_eq!(a.environment, "production");
        assert_eq!(a.folder, None);
        assert_eq!(a.key, "STRIPE_KEY");
        assert_eq!(a.env_name(), "STRIPE_KEY");

        let b = r("zv://payments-api/qa-sandbox/billing/stripe_Secret_1");
        assert_eq!(b.folder.as_deref(), Some("billing"));
        assert_eq!(b.key, "stripe_Secret_1", "keys keep their case");
        assert_eq!(
            b.to_string(),
            "zv://payments-api/qa-sandbox/billing/stripe_Secret_1"
        );
        assert_eq!(r(&b.to_string()), b);
    }

    #[test]
    fn matches_the_shared_path_rules() {
        for bad in [
            "",
            "https://web/prod/KEY",
            "zv://web/prod",
            "zv://web/prod/a/b/KEY",
            "zv://web//KEY",
            "zv://Web/prod/KEY",
            "zv://web/prod-/KEY",
            "zv://web/pr--od/KEY",
            "zv://web/prod/1KEY",
            "zv://web/prod/KEY-X",
            "zv://web/prod/KEY/",
            "zv://web/prod/billing_x/KEY",
        ] {
            assert!(bad.parse::<SecretRef>().is_err(), "{bad}");
        }
        let long_key = format!("zv://web/prod/{}", "K".repeat(128));
        assert!(long_key.parse::<SecretRef>().is_ok());
        let too_long = format!("zv://web/prod/{}", "K".repeat(129));
        assert!(too_long.parse::<SecretRef>().is_err());
        let long_slug = format!("zv://{}/prod/K", "w".repeat(65));
        assert!(long_slug.parse::<SecretRef>().is_err());
    }

    #[test]
    fn exact_scope_is_one_secret() {
        let one = p("zv://web/prod/STRIPE");
        assert!(one.allows(&r("zv://web/prod/STRIPE")));
        assert!(!one.allows(&r("zv://web/prod/pay/STRIPE")));
        assert!(!one.allows(&r("zv://web/dev/STRIPE")));
        assert!(!one.allows(&r("zv://web/prod/stripe")));
    }

    #[test]
    fn prefix_scope_covers_what_is_below_it() {
        let env = p("zv://web/dev/*");
        assert!(env.allows(&r("zv://web/dev/DB_URL")));
        assert!(env.allows(&r("zv://web/dev/payments/STRIPE")));
        assert!(!env.allows(&r("zv://web/prod/DB_URL")));
        assert!(!env.allows(&r("zv://webapp/dev/DB_URL")));

        let folder = p("zv://web/dev/payments/*");
        assert!(folder.allows(&r("zv://web/dev/payments/STRIPE")));
        assert!(!folder.allows(&r("zv://web/dev/STRIPE")));

        assert!(p("zv://web/*").allows(&r("zv://web/prod/X")));
        assert!("zv://a/b/c/d/*".parse::<ScopePattern>().is_err());
        assert!("zv://*".parse::<ScopePattern>().is_err());
    }

    #[test]
    fn parses_places() {
        let place = |s: &str| ScopePattern::parse_place(s).unwrap().to_string();
        assert_eq!(place("zv://web"), "zv://web/*");
        assert_eq!(place("zv://web/dev"), "zv://web/dev/*");
        assert_eq!(place("zv://web/dev/"), "zv://web/dev/*");
        assert_eq!(place("zv://web/dev/payments/*"), "zv://web/dev/payments/*");
        assert_eq!(place("zv://web/dev/payments/"), "zv://web/dev/payments/*");
        assert_eq!(place("zv://web/dev/STRIPE"), "zv://web/dev/STRIPE");
        assert!(ScopePattern::parse_place("web/dev").is_err());
    }

    #[test]
    fn serializes_as_strings() {
        let json = serde_json::to_string(&p("zv://web/dev/*")).unwrap();
        assert_eq!(json, "\"zv://web/dev/*\"");
        let back: ScopePattern = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p("zv://web/dev/*"));
        assert!(serde_json::from_str::<SecretRef>("\"zv://nope\"").is_err());
    }
}

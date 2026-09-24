//! `zv://` secret references and the scope patterns that allow them.
//!
//! A reference names one value in one environment of one project:
//!
//! ```text
//! zv://<project>/<environment>/[<folder>/]<item>[#<field>]
//! ```
//!
//! Folders are one level deep, so three path segments mean no folder and four
//! mean a folder. The field defaults to the item's primary value
//! ([`DEFAULT_FIELD`]). Segments are slugs (`A-Z a-z 0-9 . _ -`) and compare
//! case-insensitively; the canonical form is lowercase.
//!
//! A scope pattern is either a reference (an exact grant; without a `#field`
//! it covers every field of that item) or a path prefix ending in `/*`, which
//! covers everything below it: `zv://web/*`, `zv://web/dev/*`,
//! `zv://web/dev/stripe/*`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const SCHEME: &str = "zv://";
/// The field a reference without `#field` resolves to.
pub const DEFAULT_FIELD: &str = "password";
const MAX_SEGMENT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RefError {
    #[error("a secret reference starts with zv://")]
    Scheme,
    #[error("a secret reference is zv://project/environment/[folder/]item[#field]")]
    Shape,
    #[error("each part of a secret reference is 1 to 64 of A-Z a-z 0-9 . _ -")]
    Segment,
}

fn segment(s: &str) -> Result<String, RefError> {
    let ok = !s.is_empty()
        && s.len() <= MAX_SEGMENT
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(s.to_ascii_lowercase())
    } else {
        Err(RefError::Segment)
    }
}

/// A parsed, canonical `zv://` reference.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SecretRef {
    pub project: String,
    pub environment: String,
    pub folder: Option<String>,
    pub item: String,
    /// `None` means [`DEFAULT_FIELD`].
    pub field: Option<String>,
}

impl SecretRef {
    pub fn field_or_default(&self) -> &str {
        self.field.as_deref().unwrap_or(DEFAULT_FIELD)
    }

    fn path(&self) -> Vec<&str> {
        let mut p = vec![self.project.as_str(), self.environment.as_str()];
        if let Some(f) = &self.folder {
            p.push(f);
        }
        p.push(&self.item);
        p
    }
}

impl FromStr for SecretRef {
    type Err = RefError;

    fn from_str(s: &str) -> Result<Self, RefError> {
        let rest = s.strip_prefix(SCHEME).ok_or(RefError::Scheme)?;
        let (path, field) = match rest.split_once('#') {
            Some((p, f)) => (p, Some(segment(f)?)),
            None => (rest, None),
        };
        let parts: Vec<&str> = path.split('/').collect();
        let (project, environment, folder, item) = match parts.as_slice() {
            [p, e, i] => (p, e, None, i),
            [p, e, f, i] => (p, e, Some(f), i),
            _ => return Err(RefError::Shape),
        };
        Ok(Self {
            project: segment(project)?,
            environment: segment(environment)?,
            folder: folder.map(|f| segment(f)).transpose()?,
            item: segment(item)?,
            field,
        })
    }
}

impl fmt::Display for SecretRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{SCHEME}{}", self.path().join("/"))?;
        if let Some(field) = &self.field {
            write!(f, "#{field}")?;
        }
        Ok(())
    }
}

/// What an agent may read.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ScopePattern {
    /// One item, or one field of it when `field` is set.
    Exact(SecretRef),
    /// Everything under a path of 1 to 3 segments (project, environment,
    /// folder).
    Prefix(Vec<String>),
}

impl ScopePattern {
    pub fn allows(&self, r: &SecretRef) -> bool {
        match self {
            Self::Exact(p) => {
                p.project == r.project
                    && p.environment == r.environment
                    && p.folder == r.folder
                    && p.item == r.item
                    && p.field.as_deref().is_none_or(|f| f == r.field_or_default())
            }
            Self::Prefix(prefix) => {
                let path = r.path();
                // A prefix always stops short of the item.
                prefix.len() < path.len() && path.iter().zip(prefix).all(|(a, b)| *a == b)
            }
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
            .map(segment)
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
    fn parses_with_and_without_folder_and_field() {
        let a = r("zv://web/prod/stripe-key");
        assert_eq!(a.project, "web");
        assert_eq!(a.environment, "prod");
        assert_eq!(a.folder, None);
        assert_eq!(a.item, "stripe-key");
        assert_eq!(a.field_or_default(), DEFAULT_FIELD);

        let b = r("zv://Web/QA-sandbox/payments/Stripe_Key#secret");
        assert_eq!(b.folder.as_deref(), Some("payments"));
        assert_eq!(b.field.as_deref(), Some("secret"));
        assert_eq!(
            b.to_string(),
            "zv://web/qa-sandbox/payments/stripe_key#secret"
        );
        assert_eq!(r(&b.to_string()), b);
    }

    #[test]
    fn rejects_malformed_references() {
        for bad in [
            "",
            "https://web/prod/key",
            "zv://web/prod",
            "zv://web/prod/a/b/c",
            "zv://web//key",
            "zv://web/prod/../key",
            "zv://web/prod/ke y",
            "zv://web/prod/key#",
            "zv://web/prod/key#a#b",
            "zv://web/prod/key/",
        ] {
            assert!(bad.parse::<SecretRef>().is_err(), "{bad}");
        }
        let long = format!("zv://web/prod/{}", "k".repeat(65));
        assert!(long.parse::<SecretRef>().is_err());
    }

    #[test]
    fn exact_scope_covers_all_fields_unless_one_is_named() {
        let item = p("zv://web/prod/stripe");
        assert!(item.allows(&r("zv://web/prod/stripe")));
        assert!(item.allows(&r("zv://web/prod/stripe#username")));
        assert!(!item.allows(&r("zv://web/prod/pay/stripe")));
        assert!(!item.allows(&r("zv://web/dev/stripe")));

        let field = p("zv://web/prod/stripe#password");
        assert!(field.allows(&r("zv://web/prod/stripe")));
        assert!(!field.allows(&r("zv://web/prod/stripe#username")));
    }

    #[test]
    fn prefix_scope_covers_what_is_below_it() {
        let env = p("zv://web/dev/*");
        assert!(env.allows(&r("zv://web/dev/db-url")));
        assert!(env.allows(&r("zv://web/dev/payments/stripe#secret")));
        assert!(!env.allows(&r("zv://web/prod/db-url")));
        assert!(!env.allows(&r("zv://webapp/dev/db-url")));

        let folder = p("zv://web/dev/payments/*");
        assert!(folder.allows(&r("zv://web/dev/payments/stripe")));
        // An item named like the folder is not inside it.
        assert!(!folder.allows(&r("zv://web/dev/payments")));

        assert!(p("zv://web/*").allows(&r("zv://web/prod/x")));
        assert!("zv://a/b/c/d/*".parse::<ScopePattern>().is_err());
        assert!("zv://*".parse::<ScopePattern>().is_err());
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

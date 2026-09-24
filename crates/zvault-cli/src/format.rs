//! Text output for `zv ls` and `zv env`.

use std::collections::BTreeSet;
use std::fmt::Write;

use zvault_agent::{ScopePattern, SecretRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum EnvFormat {
    /// KEY="value", for .env files.
    Dotenv,
    /// export KEY='value', for `eval "$(zv env …)"`.
    Shell,
    /// A JSON object.
    Json,
}

/// One line per variable. Values are escaped so any string round-trips.
pub fn env(vars: &[(String, &str)], format: EnvFormat) -> String {
    let mut out = String::new();
    match format {
        EnvFormat::Dotenv => {
            for (k, v) in vars {
                let mut escaped = String::with_capacity(v.len());
                for c in v.chars() {
                    match c {
                        '\\' => escaped.push_str("\\\\"),
                        '"' => escaped.push_str("\\\""),
                        '$' => escaped.push_str("\\$"),
                        '\n' => escaped.push_str("\\n"),
                        '\r' => escaped.push_str("\\r"),
                        c => escaped.push(c),
                    }
                }
                let _ = writeln!(out, "{k}=\"{escaped}\"");
            }
        }
        EnvFormat::Shell => {
            for (k, v) in vars {
                let _ = writeln!(out, "export {k}='{}'", v.replace('\'', "'\\''"));
            }
        }
        EnvFormat::Json => {
            let map: serde_json::Map<String, serde_json::Value> = vars
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::from(*v)))
                .collect();
            out = serde_json::to_string_pretty(&map).unwrap_or_default();
            out.push('\n');
        }
    }
    out
}

/// Names the variable for each item; fails if two items would share one.
pub fn env_names(refs: &[SecretRef]) -> Result<Vec<String>, String> {
    let mut seen: Vec<(String, &SecretRef)> = Vec::new();
    for r in refs {
        let name = r.env_name().to_owned();
        if let Some((_, other)) = seen.iter().find(|(n, _)| *n == name) {
            return Err(format!("{other} and {r} would both be {name}"));
        }
        seen.push((name, r));
    }
    Ok(seen.into_iter().map(|(n, _)| n).collect())
}

/// What `zv ls` prints: the next level below `prefix`, folders with a
/// trailing `/`. With `all`, every item reference.
pub fn listing(prefix: Option<&ScopePattern>, refs: &[SecretRef], all: bool) -> Vec<String> {
    if all {
        return refs.iter().map(ToString::to_string).collect();
    }
    let depth = match prefix {
        None => 0,
        Some(ScopePattern::Prefix(p)) => p.len(),
        Some(ScopePattern::Exact(_)) => return refs.iter().map(ToString::to_string).collect(),
    };
    let mut out = BTreeSet::new();
    for r in refs.iter().filter(|r| prefix.is_none_or(|p| p.allows(r))) {
        let mut path = vec![r.project.as_str(), r.environment.as_str()];
        if let Some(f) = &r.folder {
            path.push(f);
        }
        path.push(&r.key);
        if let Some(next) = path.get(depth) {
            if depth + 1 == path.len() {
                out.insert((*next).to_owned());
            } else {
                out.insert(format!("{next}/"));
            }
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(list: &[&str]) -> Vec<SecretRef> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn formats_env_safely() {
        let vars = vec![
            ("A".to_owned(), "plain"),
            ("B".to_owned(), "it's \"$HOME\"\nnext\\"),
        ];
        assert_eq!(
            env(&vars, EnvFormat::Dotenv),
            "A=\"plain\"\nB=\"it's \\\"\\$HOME\\\"\\nnext\\\\\"\n"
        );
        assert_eq!(
            env(&vars, EnvFormat::Shell),
            "export A='plain'\nexport B='it'\\''s \"$HOME\"\nnext\\'\n"
        );
        let json: serde_json::Value = serde_json::from_str(&env(&vars, EnvFormat::Json)).unwrap();
        assert_eq!(json["B"], "it's \"$HOME\"\nnext\\");
    }

    #[test]
    fn shell_output_round_trips_through_sh() {
        let tricky = "a'b\"c$d`e\\f\ng";
        let script = format!(
            "{}printf %s \"$K\"",
            env(&[("K".to_owned(), tricky)], EnvFormat::Shell)
        );
        let out = std::process::Command::new("sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), tricky);
    }

    #[test]
    fn refuses_clashing_names() {
        assert_eq!(
            env_names(&refs(&["zv://w/d/DB_URL", "zv://w/d/API"])).unwrap(),
            ["DB_URL", "API"]
        );
        assert!(env_names(&refs(&["zv://w/d/DB_URL", "zv://w/d/f/DB_URL"])).is_err());
    }

    #[test]
    fn lists_one_level_at_a_time() {
        let all = refs(&[
            "zv://web/dev/DB",
            "zv://web/dev/pay/STRIPE",
            "zv://web/prod/DB",
            "zv://api/dev/KEY",
        ]);
        assert_eq!(listing(None, &all, false), ["api/", "web/"]);
        let web: ScopePattern = "zv://web/*".parse().unwrap();
        assert_eq!(listing(Some(&web), &all, false), ["dev/", "prod/"]);
        let dev: ScopePattern = "zv://web/dev/*".parse().unwrap();
        assert_eq!(listing(Some(&dev), &all, false), ["DB", "pay/"]);
        assert_eq!(listing(None, &all, true).len(), 4);
    }
}

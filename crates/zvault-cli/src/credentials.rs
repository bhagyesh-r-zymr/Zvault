//! Paired agents on this machine.
//!
//! The list of agents (name and id) is a small JSON file in the user's config
//! directory. Each agent's bearer token is stored in the macOS login Keychain;
//! on other systems it is kept in the same file, which is created `0600`
//! inside a `0700` directory.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
use zvault_agent::protocol::AgentAuth;

pub const AGENT_ENV: &str = "ZV_AGENT";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedAgent {
    pub name: String,
    pub agent_id: String,
    /// Only used where there is no Keychain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<Zeroizing<String>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub agents: Vec<PairedAgent>,
}

#[derive(Debug, thiserror::Error)]
pub enum CredError {
    #[error("no agent is paired on this machine; run `zv agent pair --name <name>`")]
    NonePaired,
    #[error("several agents are paired; choose one with --agent or {AGENT_ENV}: {0}")]
    Ambiguous(String),
    #[error("no paired agent is called {0:?}")]
    Unknown(String),
    #[error("an agent called {0:?} is already paired; unpair it first")]
    Exists(String),
    #[error("the saved token for {0:?} is missing; unpair and pair it again")]
    MissingToken(String),
    #[error("could not find your home directory")]
    NoHome,
    #[error("{0} must not be readable by other users; run chmod 600 on it")]
    Permissions(String),
    #[error("could not read or write agent credentials: {0}")]
    Io(#[from] std::io::Error),
    #[error("the agent credentials file is damaged: {0}")]
    Corrupt(String),
    #[error("Keychain error: {0}")]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Keychain(String),
}

pub fn default_path() -> Result<PathBuf, CredError> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .ok_or(CredError::NoHome)?;
    Ok(base.join("zvault").join("agents.json"))
}

impl Store {
    pub fn load(path: &Path) -> Result<Self, CredError> {
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(CredError::Permissions(path.display().to_string()));
        }
        let bytes = Zeroizing::new(fs::read(path)?);
        serde_json::from_slice(&bytes).map_err(|e| CredError::Corrupt(e.to_string()))
    }

    pub fn save(&self, path: &Path) -> Result<(), CredError> {
        if let Some(dir) = path.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
        }
        let json = Zeroizing::new(
            serde_json::to_vec_pretty(self).map_err(|e| CredError::Corrupt(e.to_string()))?,
        );
        let tmp = path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Picks the agent named on the command line, in `ZV_AGENT`, or the only
    /// one paired.
    pub fn select(&self, name: Option<&str>) -> Result<&PairedAgent, CredError> {
        let env = std::env::var(AGENT_ENV).ok();
        match name.or(env.as_deref()) {
            Some(n) => self
                .agents
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(n))
                .ok_or_else(|| CredError::Unknown(n.to_owned())),
            None => match self.agents.as_slice() {
                [] => Err(CredError::NonePaired),
                [only] => Ok(only),
                many => Err(CredError::Ambiguous(
                    many.iter()
                        .map(|a| a.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                )),
            },
        }
    }

    pub fn add(
        &mut self,
        name: &str,
        agent_id: &str,
        token: Zeroizing<String>,
    ) -> Result<(), CredError> {
        if self
            .agents
            .iter()
            .any(|a| a.name.eq_ignore_ascii_case(name))
        {
            return Err(CredError::Exists(name.to_owned()));
        }
        let token = keychain::store(agent_id, token)?;
        self.agents.push(PairedAgent {
            name: name.to_owned(),
            agent_id: agent_id.to_owned(),
            token,
        });
        Ok(())
    }

    pub fn remove(&mut self, agent_id: &str) -> Result<(), CredError> {
        self.agents.retain(|a| a.agent_id != agent_id);
        keychain::delete(agent_id)
    }
}

impl PairedAgent {
    pub fn auth(&self) -> Result<AgentAuth, CredError> {
        let token = match &self.token {
            Some(t) => t.clone(),
            None => keychain::load(&self.agent_id)?
                .ok_or_else(|| CredError::MissingToken(self.name.clone()))?,
        };
        Ok(AgentAuth {
            agent_id: self.agent_id.clone(),
            token,
        })
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    //! Generic-password items in the login Keychain, one per agent.

    use security_framework::passwords;
    use zeroize::Zeroizing;

    use super::CredError;

    const SERVICE: &str = "com.zvault.cli.agent";
    const NOT_FOUND: i32 = -25300; // errSecItemNotFound

    /// Returns what to keep in the file: nothing, since the Keychain has it.
    pub fn store(
        agent_id: &str,
        token: Zeroizing<String>,
    ) -> Result<Option<Zeroizing<String>>, CredError> {
        passwords::set_generic_password(SERVICE, agent_id, token.as_bytes())
            .map_err(|e| CredError::Keychain(e.to_string()))?;
        Ok(None)
    }

    pub fn load(agent_id: &str) -> Result<Option<Zeroizing<String>>, CredError> {
        match passwords::get_generic_password(SERVICE, agent_id) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                String::from_utf8(bytes.to_vec())
                    .map(|s| Some(Zeroizing::new(s)))
                    .map_err(|_| CredError::Keychain("token is not text".into()))
            }
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(CredError::Keychain(e.to_string())),
        }
    }

    pub fn delete(agent_id: &str) -> Result<(), CredError> {
        match passwords::delete_generic_password(SERVICE, agent_id) {
            Err(e) if e.code() != NOT_FOUND => Err(CredError::Keychain(e.to_string())),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use zeroize::Zeroizing;

    use super::CredError;

    /// No Keychain: the token stays in the `0600` file.
    #[allow(clippy::unnecessary_wraps)]
    pub fn store(
        _agent_id: &str,
        token: Zeroizing<String>,
    ) -> Result<Option<Zeroizing<String>>, CredError> {
        Ok(Some(token))
    }

    #[allow(clippy::unnecessary_wraps)]
    pub fn load(_agent_id: &str) -> Result<Option<Zeroizing<String>>, CredError> {
        Ok(None)
    }

    #[allow(clippy::unnecessary_wraps)]
    pub fn delete(_agent_id: &str) -> Result<(), CredError> {
        Ok(())
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zv-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("zvault").join("agents.json")
    }

    #[test]
    fn saves_privately_and_selects_agents() {
        let path = temp_path("store");
        let mut store = Store::default();
        store
            .add("Claude Code", "agt_1", Zeroizing::new("tok".into()))
            .unwrap();
        store.save(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);

        let mut store = Store::load(&path).unwrap();
        assert_eq!(store.select(Some("claude code")).unwrap().agent_id, "agt_1");
        assert_eq!(
            store
                .select(Some("claude code"))
                .unwrap()
                .auth()
                .unwrap()
                .token
                .as_str(),
            "tok"
        );
        assert!(matches!(
            store.add("claude code", "agt_2", Zeroizing::new("t".into())),
            Err(CredError::Exists(_))
        ));
        store
            .add("CI", "agt_2", Zeroizing::new("t2".into()))
            .unwrap();
        assert!(matches!(
            store.select(Some("nope")),
            Err(CredError::Unknown(_))
        ));
        store.remove("agt_1").unwrap();
        assert_eq!(store.agents.len(), 1);
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn refuses_a_world_readable_file() {
        let path = temp_path("perms");
        Store::default().save(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(Store::load(&path), Err(CredError::Permissions(_))));
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}

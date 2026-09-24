//! Paired agents and the rules that decide whether one may read a secret.
//!
//! Pure state, like the desktop app's `Session`: callers pass `now` in (as
//! Unix seconds) so the rules are unit-testable.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::protocol::{AgentStatus, ErrorCode};
use crate::reference::{ScopePattern, SecretRef};

/// How long a "15-minute session" approval lasts.
pub const SESSION_GRANT_SECS: u64 = 15 * 60;
pub const MAX_AGENTS: usize = 32;
pub const MAX_SCOPES: usize = 64;
pub const MAX_NAME: usize = 64;

/// When the user must approve an agent's request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    /// Every request, confirmed with Touch ID where available.
    #[default]
    AskEveryTime,
    /// One approval covers the same secrets for 15 minutes.
    Session15m,
    /// No prompt while Zvault is unlocked. Locking ends it.
    WhileUnlocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    /// SHA-256 of the bearer token, base64url.
    pub token_hash: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_used_at: Option<u64>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub approval: ApprovalMode,
    #[serde(default)]
    pub scopes: Vec<ScopePattern>,
}

impl AgentRecord {
    pub fn status(&self) -> AgentStatus {
        AgentStatus {
            agent_id: self.id.clone(),
            name: self.name.clone(),
            paused: self.paused,
            approval: self.approval,
            scopes: self.scopes.clone(),
        }
    }
}

/// A new random bearer token, 32 bytes as base64url.
pub fn new_token() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).expect("OS random number generator failed");
    Zeroizing::new(B64.encode(bytes.as_ref()))
}

/// A new random agent id.
pub fn new_agent_id() -> String {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).expect("OS random number generator failed");
    format!("agt_{}", B64.encode(bytes))
}

/// A six-digit code for the user to match between terminal and app.
pub fn new_pairing_code() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("OS random number generator failed");
    format!("{:06}", u32::from_be_bytes(bytes) % 1_000_000)
}

pub fn hash_token(token: &str) -> String {
    B64.encode(Sha256::digest(token.as_bytes()))
}

/// Cleans a user- or agent-supplied name for display.
pub fn clean_name(name: &str) -> Option<String> {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_NAME)
        .collect();
    (!name.is_empty()).then_some(name)
}

/// What to do with a request that passed authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Ask the user. `touch_id` asks for biometric confirmation too.
    Ask {
        touch_id: bool,
    },
    Deny(ErrorCode),
}

/// All paired agents plus the approvals currently in force.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Registry {
    agents: Vec<AgentRecord>,
    /// Session approvals: agent id -> (reference, expires at). Never saved.
    #[serde(skip)]
    grants: HashMap<String, Vec<(SecretRef, u64)>>,
}

impl Registry {
    pub fn agents(&self) -> &[AgentRecord] {
        &self.agents
    }

    pub fn get(&self, id: &str) -> Option<&AgentRecord> {
        self.agents.iter().find(|a| a.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut AgentRecord> {
        self.agents.iter_mut().find(|a| a.id == id)
    }

    /// Checks a bearer token in constant time. Returns the agent on success.
    pub fn authenticate(&self, id: &str, token: &str) -> Option<&AgentRecord> {
        let agent = self.get(id)?;
        let given = hash_token(token);
        bool::from(given.as_bytes().ct_eq(agent.token_hash.as_bytes())).then_some(agent)
    }

    /// Adds a newly approved agent and returns its token. New agents start
    /// with no scopes unless the user granted some while approving.
    pub fn pair(
        &mut self,
        name: &str,
        approval: ApprovalMode,
        scopes: Vec<ScopePattern>,
        now: u64,
    ) -> Result<(AgentRecord, Zeroizing<String>), &'static str> {
        let name = clean_name(name).ok_or("an agent needs a name")?;
        if self.agents.len() >= MAX_AGENTS {
            return Err("too many paired agents; unpair one first");
        }
        if scopes.len() > MAX_SCOPES {
            return Err("too many secret scopes");
        }
        let token = new_token();
        let record = AgentRecord {
            id: new_agent_id(),
            name,
            token_hash: hash_token(&token),
            created_at: now,
            last_used_at: None,
            paused: false,
            approval,
            scopes,
        };
        self.agents.push(record.clone());
        Ok((record, token))
    }

    pub fn unpair(&mut self, id: &str) -> Option<AgentRecord> {
        self.grants.remove(id);
        let i = self.agents.iter().position(|a| a.id == id)?;
        Some(self.agents.remove(i))
    }

    /// Changes an agent's settings. Narrowing access drops its approvals.
    pub fn update(
        &mut self,
        id: &str,
        name: Option<&str>,
        paused: Option<bool>,
        approval: Option<ApprovalMode>,
        scopes: Option<Vec<ScopePattern>>,
    ) -> Result<AgentRecord, &'static str> {
        if scopes.as_ref().is_some_and(|s| s.len() > MAX_SCOPES) {
            return Err("too many secret scopes");
        }
        let name = name
            .map(|n| clean_name(n).ok_or("an agent needs a name"))
            .transpose()?;
        let agent = self.get_mut(id).ok_or("no such agent")?;
        if let Some(n) = name {
            agent.name = n;
        }
        if let Some(p) = paused {
            agent.paused = p;
        }
        if let Some(a) = approval {
            agent.approval = a;
        }
        if let Some(s) = scopes {
            agent.scopes = s;
        }
        let record = agent.clone();
        self.grants.remove(id);
        Ok(record)
    }

    /// Decides a request from an authenticated agent.
    pub fn decide(&self, id: &str, refs: &[SecretRef], unlocked: bool, now: u64) -> Decision {
        let Some(agent) = self.get(id) else {
            return Decision::Deny(ErrorCode::Unauthorized);
        };
        if agent.paused {
            return Decision::Deny(ErrorCode::Paused);
        }
        if refs.is_empty() {
            return Decision::Deny(ErrorCode::BadRequest);
        }
        if !refs
            .iter()
            .all(|r| agent.scopes.iter().any(|s| s.allows(r)))
        {
            return Decision::Deny(ErrorCode::OutOfScope);
        }
        if !unlocked {
            return Decision::Deny(ErrorCode::Locked);
        }
        match agent.approval {
            ApprovalMode::WhileUnlocked => Decision::Allow,
            ApprovalMode::Session15m if self.granted(id, refs, now) => Decision::Allow,
            ApprovalMode::Session15m => Decision::Ask { touch_id: false },
            ApprovalMode::AskEveryTime => Decision::Ask { touch_id: true },
        }
    }

    fn granted(&self, id: &str, refs: &[SecretRef], now: u64) -> bool {
        let Some(grants) = self.grants.get(id) else {
            return false;
        };
        refs.iter()
            .all(|r| grants.iter().any(|(g, exp)| g == r && now < *exp))
    }

    /// Records a user approval so a session-mode agent is not asked again.
    pub fn approved(&mut self, id: &str, refs: &[SecretRef], now: u64) {
        let Some(agent) = self.get(id) else { return };
        if agent.approval != ApprovalMode::Session15m {
            return;
        }
        let grants = self.grants.entry(id.to_owned()).or_default();
        grants.retain(|(g, exp)| now < *exp && !refs.contains(g));
        let exp = now + SESSION_GRANT_SECS;
        grants.extend(refs.iter().map(|r| (r.clone(), exp)));
    }

    pub fn touch(&mut self, id: &str, now: u64) {
        if let Some(a) = self.get_mut(id) {
            a.last_used_at = Some(now);
        }
    }

    /// Locking Zvault ends every approval.
    pub fn on_lock(&mut self) {
        self.grants.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_790_000_000;

    fn r(s: &str) -> SecretRef {
        s.parse().unwrap()
    }

    fn registry(mode: ApprovalMode) -> (Registry, String, Zeroizing<String>) {
        let mut reg = Registry::default();
        let (rec, token) = reg
            .pair(
                "Claude Code",
                mode,
                vec!["zv://web/dev/*".parse().unwrap()],
                T0,
            )
            .unwrap();
        (reg, rec.id, token)
    }

    #[test]
    fn authenticates_only_with_the_issued_token() {
        let (reg, id, token) = registry(ApprovalMode::AskEveryTime);
        assert!(reg.authenticate(&id, &token).is_some());
        assert!(reg.authenticate(&id, "wrong").is_none());
        assert!(reg.authenticate("agt_other", &token).is_none());
        let saved = serde_json::to_string(&reg).unwrap();
        assert!(!saved.contains(token.as_str()), "token must not be stored");
    }

    #[test]
    fn scopes_pause_and_lock_are_checked_before_approval() {
        let (mut reg, id, _) = registry(ApprovalMode::WhileUnlocked);
        let dev = [r("zv://web/dev/db")];
        assert_eq!(reg.decide(&id, &dev, true, T0), Decision::Allow);
        assert_eq!(
            reg.decide(
                &id,
                &[r("zv://web/dev/db"), r("zv://web/prod/db")],
                true,
                T0
            ),
            Decision::Deny(ErrorCode::OutOfScope)
        );
        assert_eq!(
            reg.decide(&id, &dev, false, T0),
            Decision::Deny(ErrorCode::Locked)
        );
        assert_eq!(
            reg.decide(&id, &[], true, T0),
            Decision::Deny(ErrorCode::BadRequest)
        );
        reg.update(&id, None, Some(true), None, None).unwrap();
        assert_eq!(
            reg.decide(&id, &dev, true, T0),
            Decision::Deny(ErrorCode::Paused)
        );
        assert_eq!(
            reg.decide("agt_x", &dev, true, T0),
            Decision::Deny(ErrorCode::Unauthorized)
        );
    }

    #[test]
    fn ask_every_time_always_asks_with_touch_id() {
        let (mut reg, id, _) = registry(ApprovalMode::AskEveryTime);
        let refs = [r("zv://web/dev/db")];
        reg.approved(&id, &refs, T0);
        assert_eq!(
            reg.decide(&id, &refs, true, T0 + 1),
            Decision::Ask { touch_id: true }
        );
    }

    #[test]
    fn session_approval_lasts_fifteen_minutes_for_the_same_secrets() {
        let (mut reg, id, _) = registry(ApprovalMode::Session15m);
        let db = [r("zv://web/dev/db")];
        assert_eq!(
            reg.decide(&id, &db, true, T0),
            Decision::Ask { touch_id: false }
        );
        reg.approved(&id, &db, T0);
        assert_eq!(reg.decide(&id, &db, true, T0 + 60), Decision::Allow);
        // A different secret still asks.
        assert_eq!(
            reg.decide(&id, &[r("zv://web/dev/api")], true, T0 + 60),
            Decision::Ask { touch_id: false }
        );
        assert_eq!(
            reg.decide(&id, &db, true, T0 + SESSION_GRANT_SECS),
            Decision::Ask { touch_id: false }
        );
    }

    #[test]
    fn locking_and_settings_changes_end_approvals() {
        let (mut reg, id, _) = registry(ApprovalMode::Session15m);
        let db = [r("zv://web/dev/db")];
        reg.approved(&id, &db, T0);
        reg.on_lock();
        assert_ne!(reg.decide(&id, &db, true, T0 + 1), Decision::Allow);

        reg.approved(&id, &db, T0);
        reg.update(
            &id,
            None,
            None,
            None,
            Some(vec!["zv://web/dev/*".parse().unwrap()]),
        )
        .unwrap();
        assert_ne!(reg.decide(&id, &db, true, T0 + 1), Decision::Allow);
    }

    #[test]
    fn unpair_removes_the_agent() {
        let (mut reg, id, token) = registry(ApprovalMode::WhileUnlocked);
        assert!(reg.unpair(&id).is_some());
        assert!(reg.authenticate(&id, &token).is_none());
        assert!(reg.agents().is_empty());
    }

    #[test]
    fn names_are_cleaned_and_bounded() {
        assert_eq!(
            clean_name("  Claude\u{7}Code \n").as_deref(),
            Some("ClaudeCode")
        );
        assert_eq!(clean_name(" \t "), None);
        assert_eq!(clean_name(&"x".repeat(100)).unwrap().len(), MAX_NAME);
        assert_eq!(new_pairing_code().len(), 6);
    }
}

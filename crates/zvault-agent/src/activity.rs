//! The per-agent activity log: every use and every denial.
//!
//! Entries hold references and outcomes, never secret values.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::protocol::{ErrorCode, Purpose};
use crate::reference::SecretRef;

/// Entries kept across all agents; the oldest are dropped first.
pub const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Paired,
    /// Values were released without a prompt (a policy or earlier approval allowed it).
    Allowed,
    /// The user approved the request in Zvault.
    Approved,
    Denied,
    Unpaired,
}

/// How the app verified the approving user, when a prompt was shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verification {
    TouchId,
    Click,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub at: u64,
    pub agent_id: String,
    pub agent_name: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub refs: Vec<SecretRef>,
    #[serde(default)]
    pub purpose: Option<Purpose>,
    #[serde(default)]
    pub reason: Option<ErrorCode>,
    #[serde(default)]
    pub verified_by: Option<Verification>,
    /// Process id of the `zv` process, as seen by the OS.
    #[serde(default)]
    pub peer_pid: Option<i32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ActivityLog {
    entries: VecDeque<ActivityEntry>,
}

impl ActivityLog {
    pub fn push(&mut self, entry: ActivityEntry) {
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Newest first, optionally for one agent.
    pub fn recent(&self, agent_id: Option<&str>, limit: usize) -> Vec<ActivityEntry> {
        self.entries
            .iter()
            .rev()
            .filter(|e| agent_id.is_none_or(|id| e.agent_id == id))
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: u64, agent: &str) -> ActivityEntry {
        ActivityEntry {
            at,
            agent_id: agent.into(),
            agent_name: agent.into(),
            outcome: Outcome::Allowed,
            refs: vec![],
            purpose: None,
            reason: None,
            verified_by: None,
            peer_pid: None,
        }
    }

    #[test]
    fn keeps_newest_first_and_is_bounded() {
        let mut log = ActivityLog::default();
        for i in 0..(MAX_ENTRIES as u64 + 5) {
            log.push(entry(i, if i % 2 == 0 { "a" } else { "b" }));
        }
        assert_eq!(log.len(), MAX_ENTRIES);
        let a = log.recent(Some("a"), 3);
        assert_eq!(a.len(), 3);
        assert!(a.iter().all(|e| e.agent_id == "a"));
        assert!(a[0].at > a[1].at);
        assert_eq!(log.recent(None, 1)[0].at, MAX_ENTRIES as u64 + 4);
    }
}

//! Local agent access for Zvault.
//!
//! Coding agents and scripts use approved secrets through the `zv` CLI. `zv`
//! never holds the master password or any vault key: it asks the running
//! desktop app over a Unix socket, the app checks the agent's policy, asks the
//! user when the policy says so, and returns only the requested values. `zv
//! run` then puts them in one child process's environment and masks them in
//! its output.
//!
//! This crate holds what both sides share and can be tested without either:
//! the `zv://` reference format, the wire protocol, per-agent policy, the
//! activity log and output masking.

pub mod activity;
pub mod mask;
pub mod paths;
pub mod policy;
pub mod protocol;
pub mod reference;

pub use policy::{ApprovalMode, Decision, Registry};
pub use reference::{ScopePattern, SecretRef};

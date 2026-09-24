//! Password and passphrase generation, and password strength estimation.
//!
//! Every random choice comes from the operating system's CSPRNG and is
//! unbiased (rejection sampling, never a plain modulo). Generators report the
//! exact entropy of what they produce, so the UI can show real numbers for
//! generated secrets instead of guessing from the output.
//!
//! Strength estimation for passwords a person typed uses zxcvbn, which
//! models dictionary words, keyboard patterns, dates and common substitutions.

mod error;
mod passphrase;
mod password;
mod random;
mod strength;

pub use error::{Error, Result};
pub use passphrase::{
    MAX_WORDS, MIN_WORDS, PassphraseOptions, Separator, WORDLIST_LEN, generate_passphrase,
};
pub use password::{MAX_LENGTH, MIN_LENGTH, PasswordOptions, generate_password};
pub use strength::{Strength, estimate_strength};

use serde::Serialize;

/// A generated secret together with the entropy of the process that made it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub value: String,
    /// log2 of the number of equally likely outputs for these options.
    pub entropy_bits: f64,
}

//! Zvault's phone app core. Flutter calls the functions in [`api`]; keys are
//! unwrapped and held here and wiped on lock. Dart relays ciphertext records
//! from the API and gets back only what a screen has to show.

pub mod api;
mod keyring;
mod records;

#[allow(unsafe_code, clippy::all)]
mod frb_generated;

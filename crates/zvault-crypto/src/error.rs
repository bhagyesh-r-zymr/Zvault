/// Errors are deliberately coarse so they never leak which check failed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid key derivation parameters")]
    InvalidKdfParams,
    #[error("invalid Secret Key")]
    InvalidSecretKey,
    #[error("decryption failed")]
    Decrypt,
    #[error("encryption failed")]
    Encrypt,
    #[error("secure random number generator unavailable")]
    Rng,
}

pub type Result<T> = core::result::Result<T, Error>;

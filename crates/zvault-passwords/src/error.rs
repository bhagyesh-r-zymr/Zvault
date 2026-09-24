#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid generator options")]
    InvalidOptions,
    #[error("secure random number generator unavailable")]
    Rng,
}

pub type Result<T> = core::result::Result<T, Error>;

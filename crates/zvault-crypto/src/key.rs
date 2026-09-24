use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Result, random};

pub const KEY_LEN: usize = 32;

/// A 256-bit symmetric key that is wiped from memory when dropped.
///
/// It is intentionally not `Clone`, `Copy` or `Debug` so it cannot be
/// duplicated or logged by accident.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SymmetricKey([u8; KEY_LEN]);

impl SymmetricKey {
    /// Generates a fresh random key (for a vault, an item or a share link).
    pub fn generate() -> Result<Self> {
        Ok(Self(random::array()?))
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

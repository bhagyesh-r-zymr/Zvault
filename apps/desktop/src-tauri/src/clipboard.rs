//! Copying secrets to the system clipboard, and taking them back off it.
//!
//! A copied secret is marked so clipboard managers and Universal Clipboard
//! skip it (`org.nspasteboard.ConcealedType` on macOS), and is cleared after
//! the configured delay or when the vault locks. It is only cleared if the
//! clipboard still holds exactly what Zvault put there, so something the user
//! copied since is never wiped.
//!
//! To recognise our value later without keeping the secret in memory, only a
//! salted SHA-256 of it is kept.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use zvault_crypto::SymmetricKey;

#[derive(Debug, thiserror::Error)]
#[error("clipboard unavailable: {0}")]
pub struct ClipboardError(String);

impl From<arboard::Error> for ClipboardError {
    fn from(e: arboard::Error) -> Self {
        Self(e.to_string())
    }
}

/// Recognises a copied value without storing it.
struct Fingerprint {
    salt: SymmetricKey,
    digest: [u8; 32],
}

impl Fingerprint {
    fn new(text: &str) -> Result<Self, ClipboardError> {
        let salt = SymmetricKey::generate().map_err(|e| ClipboardError(e.to_string()))?;
        let digest = Self::hash(&salt, text);
        Ok(Self { salt, digest })
    }

    fn hash(salt: &SymmetricKey, text: &str) -> [u8; 32] {
        Sha256::new()
            .chain_update(salt.as_bytes())
            .chain_update(text.as_bytes())
            .finalize()
            .into()
    }

    fn matches(&self, text: &str) -> bool {
        // Not secret-dependent timing in any useful way: the digest is salted
        // and the comparison input comes from the local clipboard.
        Self::hash(&self.salt, text) == self.digest
    }
}

struct Pending {
    fingerprint: Fingerprint,
    generation: u64,
}

#[derive(Default)]
struct Inner {
    /// Kept alive: on X11 the clipboard contents are served by this object.
    clipboard: Option<arboard::Clipboard>,
    pending: Option<Pending>,
    generation: u64,
}

impl Inner {
    fn clipboard(&mut self) -> Result<&mut arboard::Clipboard, ClipboardError> {
        if self.clipboard.is_none() {
            self.clipboard = Some(arboard::Clipboard::new()?);
        }
        Ok(self.clipboard.as_mut().expect("just set"))
    }
}

#[derive(Default)]
pub struct ClipboardGuard {
    inner: Mutex<Inner>,
}

impl ClipboardGuard {
    /// Copies `text` and schedules it to be cleared after `clear_after`.
    pub fn copy_secret(
        self: &Arc<Self>,
        text: &str,
        clear_after: Duration,
    ) -> Result<(), ClipboardError> {
        let generation = {
            let mut inner = self.lock();
            let fingerprint = Fingerprint::new(text)?;
            write_concealed(inner.clipboard()?, text)?;
            inner.generation += 1;
            let generation = inner.generation;
            inner.pending = Some(Pending {
                fingerprint,
                generation,
            });
            generation
        };

        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("zvault-clipboard-clear".into())
            .spawn(move || {
                std::thread::sleep(clear_after);
                this.clear_if_ours(Some(generation));
            })
            .map_err(|e| ClipboardError(e.to_string()))?;
        Ok(())
    }

    /// Clears the clipboard if it still holds the last secret we copied.
    /// With `only_generation`, does nothing if a newer copy has replaced it
    /// (that copy has its own timer).
    pub fn clear_if_ours(&self, only_generation: Option<u64>) {
        let mut inner = self.lock();
        let Some(pending) = inner.pending.take() else {
            return;
        };
        if only_generation.is_some_and(|g| g != pending.generation) {
            inner.pending = Some(pending);
            return;
        }
        let Ok(clipboard) = inner.clipboard() else {
            return;
        };
        // Non-text content or a read error means someone else owns it now.
        if clipboard
            .get_text()
            .is_ok_and(|current| pending.fingerprint.matches(&current))
        {
            let _ = clipboard.clear();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves nothing half-written that
        // matters here, so recover rather than propagate the poison.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn write_concealed(clipboard: &mut arboard::Clipboard, text: &str) -> Result<(), ClipboardError> {
    let set = clipboard.set();
    #[cfg(target_os = "macos")]
    let set = arboard::SetExtApple::exclude_from_history(set);
    #[cfg(windows)]
    let set = {
        use arboard::SetExtWindows;
        set.exclude_from_history()
            .exclude_from_cloud()
            .exclude_from_monitoring()
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let set = arboard::SetExtLinux::exclude_from_history(set);
    set.text(text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_matches_only_the_same_text() {
        let f = Fingerprint::new("hunter2").unwrap();
        assert!(f.matches("hunter2"));
        assert!(!f.matches("hunter3"));
        assert!(!f.matches(""));
    }

    #[test]
    fn fingerprints_are_salted() {
        let a = Fingerprint::new("hunter2").unwrap();
        let b = Fingerprint::new("hunter2").unwrap();
        assert_ne!(a.digest, b.digest);
    }
}

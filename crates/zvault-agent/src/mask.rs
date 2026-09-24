//! Replaces secret values in a child process's output as it streams.

use zeroize::Zeroizing;

pub const MASK: &[u8] = b"********";

/// Values shorter than this are not masked: masking `1` or `true` would
/// mangle ordinary output without hiding anything.
pub const MIN_MASKED_LEN: usize = 4;

/// A streaming masker. Bytes that might be the start of a secret split across
/// two writes are held back until the next chunk or [`Masker::finish`].
pub struct Masker {
    secrets: Vec<Zeroizing<Vec<u8>>>,
    pending: Zeroizing<Vec<u8>>,
    longest: usize,
}

impl Masker {
    pub fn new<'a>(secrets: impl IntoIterator<Item = &'a [u8]>) -> Self {
        let mut secrets: Vec<Zeroizing<Vec<u8>>> = secrets
            .into_iter()
            .filter(|s| s.len() >= MIN_MASKED_LEN)
            .map(|s| Zeroizing::new(s.to_vec()))
            .collect();
        // Longest first, so a secret containing another is masked whole.
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup_by(|a, b| a[..] == b[..]);
        let longest = secrets.first().map_or(0, |s| s.len());
        Self {
            secrets,
            pending: Zeroizing::new(Vec::new()),
            longest,
        }
    }

    /// Masks `chunk` and returns what can be written now.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        if self.secrets.is_empty() {
            return std::mem::take(&mut *self.pending);
        }
        let (out, consumed) = self.scan(false);
        self.pending.drain(..consumed);
        out
    }

    /// Masks and returns everything still held back.
    pub fn finish(&mut self) -> Vec<u8> {
        let (out, _) = self.scan(true);
        self.pending.clear();
        out
    }

    fn scan(&self, all: bool) -> (Vec<u8>, usize) {
        let buf = &self.pending[..];
        let mut out = Vec::with_capacity(buf.len());
        let mut i = 0;
        // Past `safe`, a secret might still be completed by later input.
        let safe = if all {
            buf.len()
        } else {
            buf.len().saturating_sub(self.longest - 1)
        };
        'outer: while i < buf.len() {
            for s in &self.secrets {
                if buf[i..].starts_with(s) {
                    out.extend_from_slice(MASK);
                    i += s.len();
                    continue 'outer;
                }
            }
            if i >= safe {
                break;
            }
            out.push(buf[i]);
            i += 1;
        }
        (out, i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(secrets: &[&str], chunks: &[&str]) -> String {
        let mut m = Masker::new(secrets.iter().map(|s| s.as_bytes()));
        let mut out = Vec::new();
        for c in chunks {
            out.extend(m.push(c.as_bytes()));
        }
        out.extend(m.finish());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn masks_whole_and_split_secrets() {
        assert_eq!(run(&["hunter22"], &["pw=hunter22!"]), "pw=********!");
        assert_eq!(
            run(&["hunter22"], &["pw=hun", "ter", "22 and hunter22"]),
            "pw=******** and ********"
        );
        assert_eq!(run(&["hunter22"], &["hunter2"]), "hunter2");
    }

    #[test]
    fn masks_the_longer_of_overlapping_secrets() {
        assert_eq!(
            run(&["abcd", "abcdefgh"], &["xabcdefghx abcd"]),
            "x********x ********"
        );
    }

    #[test]
    fn leaves_short_values_and_plain_output_alone() {
        assert_eq!(run(&["on"], &["turn on"]), "turn on");
        assert_eq!(run(&[], &["a", "b"]), "ab");
    }

    #[test]
    fn streams_without_holding_more_than_a_secret() {
        let mut m = Masker::new([b"secret-value".as_slice()]);
        let out = m.push(b"0123456789abcdefghij");
        // All but the last 11 bytes can be released now.
        assert_eq!(out, b"012345678");
        assert_eq!(m.finish(), b"9abcdefghij");
    }
}

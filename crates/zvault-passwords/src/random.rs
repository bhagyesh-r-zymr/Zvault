use crate::{Error, Result};

/// Returns a uniformly distributed integer in `0..n` from the OS CSPRNG.
///
/// Uses rejection sampling: values in the final partial block of `2^64 mod n`
/// are redrawn, so no outcome is more likely than another.
pub(crate) fn below(n: usize) -> Result<usize> {
    assert!(n > 0, "range must not be empty");
    let n = n as u64;
    // 2^64 mod n, computed without overflowing.
    let rem = (u64::MAX % n + 1) % n;
    let limit = u64::MAX - rem;
    loop {
        let mut buf = [0u8; 8];
        getrandom::fill(&mut buf).map_err(|_| Error::Rng)?;
        let x = u64::from_le_bytes(buf);
        if x <= limit {
            return Ok((x % n) as usize);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_in_range_and_hits_every_value() {
        let mut seen = [0u32; 7];
        for _ in 0..7_000 {
            seen[below(7).unwrap()] += 1;
        }
        // Each bucket expects 1000; 700 is far outside any plausible variance.
        assert!(seen.iter().all(|&c| c > 700), "{seen:?}");
    }

    #[test]
    fn range_of_one_is_always_zero() {
        assert_eq!(below(1).unwrap(), 0);
    }
}

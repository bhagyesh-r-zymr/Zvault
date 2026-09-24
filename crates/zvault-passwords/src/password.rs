use serde::Deserialize;

use crate::{Error, Generated, Result, random};

pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;

const LOWERCASE: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
/// Symbols most sites accept. Quotes, backslash, backtick, pipe and space are
/// left out: they break forms and shell pastes more often than they help.
const SYMBOLS: &str = "!#$%&()*+,-./:;<=>?@[]^_{}~";
/// Characters easily confused with one another when read or retyped.
const AMBIGUOUS: &str = "0O1Il";

/// Draws are redone until every selected class appears. With the minimum
/// length the worst case still succeeds about 40% of the time, so hitting
/// this cap means the RNG is broken rather than unlucky.
const MAX_ATTEMPTS: usize = 1_000;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PasswordOptions {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

impl Default for PasswordOptions {
    fn default() -> Self {
        Self {
            length: 20,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        }
    }
}

impl PasswordOptions {
    fn classes(&self) -> Vec<Vec<char>> {
        [
            (self.lowercase, LOWERCASE),
            (self.uppercase, UPPERCASE),
            (self.digits, DIGITS),
            (self.symbols, SYMBOLS),
        ]
        .into_iter()
        .filter(|(enabled, _)| *enabled)
        .map(|(_, set)| {
            set.chars()
                .filter(|c| !(self.avoid_ambiguous && AMBIGUOUS.contains(*c)))
                .collect()
        })
        .collect()
    }
}

/// Generates a random password containing at least one character from each
/// selected class.
///
/// The result is uniform over all such passwords: characters are drawn from
/// the combined pool and the whole draw is repeated if a class is missing.
/// (Forcing one character per class and shuffling would favour some outputs.)
pub fn generate_password(options: &PasswordOptions) -> Result<Generated> {
    if !(MIN_LENGTH..=MAX_LENGTH).contains(&options.length) {
        return Err(Error::InvalidOptions);
    }
    let classes = options.classes();
    if classes.is_empty() {
        return Err(Error::InvalidOptions);
    }
    let pool: Vec<char> = classes.iter().flatten().copied().collect();

    for _ in 0..MAX_ATTEMPTS {
        let mut value = String::with_capacity(options.length);
        for _ in 0..options.length {
            value.push(pool[random::below(pool.len())?]);
        }
        if classes
            .iter()
            .all(|class| value.chars().any(|c| class.contains(&c)))
        {
            let sizes: Vec<usize> = classes.iter().map(Vec::len).collect();
            return Ok(Generated {
                value,
                entropy_bits: entropy_bits(options.length, &sizes),
            });
        }
    }
    Err(Error::Rng)
}

/// log2 of the number of length-`len` strings over the union of `classes`
/// that use every class at least once, by inclusion-exclusion.
///
/// Computed as `len * log2(pool) + log2(fraction valid)` so it stays finite
/// for long passwords.
fn entropy_bits(len: usize, classes: &[usize]) -> f64 {
    let pool: usize = classes.iter().sum();
    let pool_f = pool as f64;
    let len_i = i32::try_from(len).expect("length is bounded");
    let mut fraction = 0.0;
    for mask in 0u32..(1 << classes.len()) {
        let excluded: usize = classes
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, size)| size)
            .sum();
        let term = ((pool - excluded) as f64 / pool_f).powi(len_i);
        if mask.count_ones() % 2 == 0 {
            fraction += term;
        } else {
            fraction -= term;
        }
    }
    len as f64 * pool_f.log2() + fraction.log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(length: usize) -> PasswordOptions {
        PasswordOptions {
            length,
            ..PasswordOptions::default()
        }
    }

    #[test]
    fn has_requested_length_and_every_class() {
        for len in [MIN_LENGTH, 20, MAX_LENGTH] {
            for _ in 0..50 {
                let pw = generate_password(&opts(len)).unwrap().value;
                assert_eq!(pw.chars().count(), len);
                assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
                assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
                assert!(pw.chars().any(|c| c.is_ascii_digit()));
                assert!(pw.chars().any(|c| SYMBOLS.contains(c)));
            }
        }
    }

    #[test]
    fn respects_disabled_classes_and_ambiguity() {
        let options = PasswordOptions {
            length: 64,
            lowercase: false,
            uppercase: true,
            digits: true,
            symbols: false,
            avoid_ambiguous: true,
        };
        for _ in 0..50 {
            let pw = generate_password(&options).unwrap().value;
            assert!(
                pw.chars()
                    .all(|c| (c.is_ascii_uppercase() || c.is_ascii_digit())
                        && !AMBIGUOUS.contains(c)),
                "{pw}"
            );
        }
    }

    #[test]
    fn rejects_bad_options() {
        assert_eq!(
            generate_password(&opts(MIN_LENGTH - 1)).unwrap_err(),
            Error::InvalidOptions
        );
        assert_eq!(
            generate_password(&opts(MAX_LENGTH + 1)).unwrap_err(),
            Error::InvalidOptions
        );
        let none = PasswordOptions {
            lowercase: false,
            uppercase: false,
            digits: false,
            symbols: false,
            ..PasswordOptions::default()
        };
        assert_eq!(generate_password(&none).unwrap_err(), Error::InvalidOptions);
    }

    #[test]
    fn outputs_do_not_repeat() {
        let a = generate_password(&opts(MIN_LENGTH)).unwrap().value;
        let b = generate_password(&opts(MIN_LENGTH)).unwrap().value;
        assert_ne!(a, b);
    }

    #[test]
    fn entropy_matches_brute_force_count() {
        // Length 3 over {a,b} and {0}: of the 27 strings, 8 lack a digit and
        // 1 lacks a letter, leaving 18.
        let bits = entropy_bits(3, &[2, 1]);
        assert!((bits - 18f64.log2()).abs() < 1e-9, "{bits}");
    }

    #[test]
    fn entropy_of_single_class_is_len_log2_pool() {
        let bits = entropy_bits(10, &[10]);
        assert!((bits - 10.0 * 10f64.log2()).abs() < 1e-9);
    }

    #[test]
    fn entropy_of_default_is_about_128_bits() {
        let g = generate_password(&PasswordOptions::default()).unwrap();
        // 20 chars over 89 symbols is 129.5 bits before the class constraint.
        assert!(
            g.entropy_bits > 128.0 && g.entropy_bits < 129.6,
            "{}",
            g.entropy_bits
        );
    }

    #[test]
    fn long_passwords_have_finite_entropy() {
        let g = generate_password(&opts(MAX_LENGTH)).unwrap();
        assert!(g.entropy_bits.is_finite() && g.entropy_bits > 800.0);
    }

    #[test]
    fn deserializes_partial_camel_case_options() {
        let o: PasswordOptions =
            serde_json::from_str(r#"{"length":32,"avoidAmbiguous":true}"#).unwrap();
        assert_eq!(o.length, 32);
        assert!(o.avoid_ambiguous && o.symbols);
    }
}

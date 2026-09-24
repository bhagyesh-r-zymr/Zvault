use std::sync::OnceLock;

use serde::Deserialize;

use crate::{Error, Generated, Result, random};

pub const MIN_WORDS: usize = 3;
pub const MAX_WORDS: usize = 20;
pub const WORDLIST_LEN: usize = 7776;

/// The EFF large wordlist (CC BY 3.0, <https://www.eff.org/dice>), kept
/// byte-for-byte as published, dice numbers included, so it can be checked
/// against the original. SHA-256:
/// addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e
const EFF_LARGE_WORDLIST: &str = include_str!("../wordlists/eff_large_wordlist.txt");

fn words() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| {
        EFF_LARGE_WORDLIST
            .lines()
            .filter_map(|line| line.split_once('\t').map(|(_, word)| word))
            .collect()
    })
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Separator {
    Hyphen,
    Space,
    Period,
    Comma,
    Underscore,
    /// A random digit between each pair of words (adds entropy).
    Digit,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PassphraseOptions {
    pub words: usize,
    pub separator: Separator,
    pub capitalize: bool,
}

impl Default for PassphraseOptions {
    fn default() -> Self {
        Self {
            words: 5,
            separator: Separator::Hyphen,
            capitalize: false,
        }
    }
}

/// Generates a diceware-style passphrase from the EFF large wordlist.
///
/// Each word adds log2(7776) ≈ 12.9 bits; five words is about 64.6 bits,
/// which Argon2id stretching makes a strong master password.
pub fn generate_passphrase(options: &PassphraseOptions) -> Result<Generated> {
    if !(MIN_WORDS..=MAX_WORDS).contains(&options.words) {
        return Err(Error::InvalidOptions);
    }
    let list = words();
    let mut value = String::new();
    for i in 0..options.words {
        if i > 0 {
            match options.separator {
                Separator::Hyphen => value.push('-'),
                Separator::Space => value.push(' '),
                Separator::Period => value.push('.'),
                Separator::Comma => value.push(','),
                Separator::Underscore => value.push('_'),
                Separator::Digit => {
                    let digit = u32::try_from(random::below(10)?).expect("below 10");
                    value.push(char::from_digit(digit, 10).expect("below 10"));
                }
            }
        }
        let word = list[random::below(list.len())?];
        if options.capitalize {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                value.extend(first.to_uppercase());
                value.push_str(chars.as_str());
            }
        } else {
            value.push_str(word);
        }
    }

    let mut entropy_bits = options.words as f64 * (list.len() as f64).log2();
    if options.separator == Separator::Digit {
        entropy_bits += (options.words - 1) as f64 * 10f64.log2();
    }
    Ok(Generated {
        value,
        entropy_bits,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn wordlist_is_complete_unique_and_in_dice_order() {
        let list = words();
        assert_eq!(list.len(), WORDLIST_LEN);
        assert_eq!(list.iter().collect::<HashSet<_>>().len(), WORDLIST_LEN);
        assert!(
            list.iter()
                .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
        );
        assert_eq!(list[0], "abacus");
        assert_eq!(list[WORDLIST_LEN - 1], "zoom");
        // Dice numbers run 11111..=66666 in order, so no line was dropped.
        let mut expected = Vec::new();
        for n in 0..WORDLIST_LEN {
            let mut d = n;
            let mut s = [0u8; 5];
            for slot in s.iter_mut().rev() {
                *slot = b'1' + (d % 6) as u8;
                d /= 6;
            }
            expected.push(String::from_utf8(s.to_vec()).unwrap());
        }
        let dice: Vec<&str> = EFF_LARGE_WORDLIST
            .lines()
            .map(|l| l.split_once('\t').unwrap().0)
            .collect();
        assert_eq!(dice, expected);
    }

    #[test]
    fn uses_requested_word_count_and_separator() {
        let options = PassphraseOptions {
            words: 6,
            separator: Separator::Period,
            capitalize: false,
        };
        let g = generate_passphrase(&options).unwrap();
        let parts: Vec<&str> = g.value.split('.').collect();
        assert_eq!(parts.len(), 6);
        assert!(parts.iter().all(|p| words().contains(p)), "{}", g.value);
        assert!((g.entropy_bits - 6.0 * 7776f64.log2()).abs() < 1e-9);
    }

    #[test]
    fn digit_separator_adds_entropy() {
        let options = PassphraseOptions {
            words: 4,
            separator: Separator::Digit,
            capitalize: true,
        };
        let g = generate_passphrase(&options).unwrap();
        let parts: Vec<&str> = g.value.split(|c: char| c.is_ascii_digit()).collect();
        assert_eq!(parts.len(), 4, "{}", g.value);
        assert!(
            parts
                .iter()
                .all(|p| p.starts_with(|c: char| c.is_ascii_uppercase()))
        );
        let expected = 4.0 * 7776f64.log2() + 3.0 * 10f64.log2();
        assert!((g.entropy_bits - expected).abs() < 1e-9);
    }

    #[test]
    fn rejects_bad_word_counts() {
        for words in [0, MIN_WORDS - 1, MAX_WORDS + 1] {
            let options = PassphraseOptions {
                words,
                ..PassphraseOptions::default()
            };
            assert_eq!(
                generate_passphrase(&options).unwrap_err(),
                Error::InvalidOptions
            );
        }
    }

    #[test]
    fn deserializes_camel_case() {
        let o: PassphraseOptions =
            serde_json::from_str(r#"{"words":7,"separator":"digit"}"#).unwrap();
        assert_eq!(o.words, 7);
        assert_eq!(o.separator, Separator::Digit);
    }
}

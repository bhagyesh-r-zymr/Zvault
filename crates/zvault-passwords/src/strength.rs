use serde::Serialize;

/// zxcvbn's estimate for a password a person chose or typed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Strength {
    /// 0 (guessable in 10^3 tries) to 4 (more than 10^10 tries).
    pub score: u8,
    /// log10 of the estimated number of guesses an attacker needs.
    pub guesses_log10: f64,
    /// Time to crack against a fast offline hash (10^10 guesses/s): the
    /// conservative case for a password reused on a breached site.
    pub crack_time_offline: String,
    /// Time to crack by guessing against an unthrottled login (10 guesses/s).
    pub crack_time_online: String,
    pub warning: Option<String>,
    pub suggestions: Vec<String>,
}

/// Estimates how guessable `password` is.
///
/// `user_inputs` are strings an attacker would try first, such as the
/// account email or name; a password built from them scores lower. zxcvbn
/// only looks at the first 100 characters, which bounds the work for
/// pathological input.
pub fn estimate_strength(password: &str, user_inputs: &[&str]) -> Strength {
    let entropy = zxcvbn::zxcvbn(password, user_inputs);
    let crack_times = entropy.crack_times();
    let feedback = entropy.feedback();
    Strength {
        score: entropy.score().into(),
        guesses_log10: entropy.guesses_log10().max(0.0),
        crack_time_offline: crack_times
            .offline_fast_hashing_1e10_per_second()
            .to_string(),
        crack_time_online: crack_times.online_no_throttling_10_per_second().to_string(),
        warning: feedback.and_then(|f| f.warning()).map(|w| w.to_string()),
        suggestions: feedback
            .map(|f| f.suggestions().iter().map(ToString::to_string).collect())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PassphraseOptions, PasswordOptions, generate_passphrase, generate_password};

    #[test]
    fn common_password_is_weak_with_feedback() {
        let s = estimate_strength("password1", &[]);
        assert_eq!(s.score, 0);
        assert!(s.warning.is_some() || !s.suggestions.is_empty());
    }

    #[test]
    fn empty_password_scores_zero_without_infinities() {
        let s = estimate_strength("", &[]);
        assert_eq!(s.score, 0);
        assert!(s.guesses_log10.is_finite());
        // NaN and infinity would not survive the trip to JSON.
        assert!(
            serde_json::to_string(&s)
                .unwrap()
                .contains("\"guessesLog10\":0.0")
        );
    }

    #[test]
    fn user_inputs_lower_the_score() {
        let alone = estimate_strength("alicezvault", &[]);
        let known = estimate_strength("alicezvault", &["alice", "zvault"]);
        assert!(known.guesses_log10 < alone.guesses_log10);
    }

    #[test]
    fn generated_secrets_score_four() {
        let pw = generate_password(&PasswordOptions::default())
            .unwrap()
            .value;
        assert_eq!(estimate_strength(&pw, &[]).score, 4);
        let pp = generate_passphrase(&PassphraseOptions::default())
            .unwrap()
            .value;
        assert_eq!(estimate_strength(&pp, &[]).score, 4);
    }

    #[test]
    fn very_long_input_is_bounded() {
        let long = "a".repeat(100_000);
        let s = estimate_strength(&long, &[]);
        assert!(s.score <= 4);
    }
}

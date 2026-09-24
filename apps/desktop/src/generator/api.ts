import { invoke } from '@tauri-apps/api/core';

/**
 * Bridge to the Rust password generator and strength estimator. Every random
 * choice is made in Rust from the OS CSPRNG; nothing here uses Math.random.
 */

/** Must match `MIN_LENGTH`/`MAX_LENGTH` in `zvault-passwords`. */
export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;
/** Must match `MIN_WORDS`/`MAX_WORDS` in `zvault-passwords`. */
export const PASSPHRASE_WORDS = { min: 3, max: 20 } as const;

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export type Separator = 'hyphen' | 'space' | 'period' | 'comma' | 'underscore' | 'digit';

export interface PassphraseOptions {
  words: number;
  separator: Separator;
  capitalize: boolean;
}

export interface Generated {
  value: string;
  /** log2 of the number of equally likely outputs for the chosen options. */
  entropyBits: number;
}

export interface Strength {
  /** zxcvbn score, 0 (trivially guessable) to 4 (strong). */
  score: number;
  guessesLog10: number;
  crackTimeOffline: string;
  crackTimeOnline: string;
  warning: string | null;
  suggestions: string[];
}

export const generator = {
  password: (options: PasswordOptions) => invoke<Generated>('generate_password', { options }),
  passphrase: (options: PassphraseOptions) => invoke<Generated>('generate_passphrase', { options }),
  /**
   * `userInputs` are values an attacker would try first (email, name); a
   * password built from them scores lower.
   */
  strength: (password: string, userInputs: string[] = []) =>
    invoke<Strength>('check_password_strength', { password, userInputs }),
};

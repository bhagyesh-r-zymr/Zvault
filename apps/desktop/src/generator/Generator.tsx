import { useCallback, useEffect, useState } from 'react';
import { lock } from '../lock.js';
import {
  generator,
  PASSPHRASE_WORDS,
  PASSWORD_LENGTH,
  type Generated,
  type PassphraseOptions,
  type PasswordOptions,
  type Separator,
} from './api.js';
import { ratingFromEntropy } from './rating.js';
import { StrengthMeter } from './StrengthMeter.js';
import { ErrorLine, SecretText } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

type Mode = 'password' | 'passphrase';

const SEPARATORS: { value: Separator; label: string }[] = [
  { value: 'hyphen', label: 'Hyphens' },
  { value: 'space', label: 'Spaces' },
  { value: 'period', label: 'Periods' },
  { value: 'comma', label: 'Commas' },
  { value: 'underscore', label: 'Underscores' },
  { value: 'digit', label: 'Random digits' },
];

const CLASS_OPTIONS = [
  ['lowercase', 'a–z'],
  ['uppercase', 'A–Z'],
  ['digits', '0–9'],
  ['symbols', '!#$%'],
] as const;

export function Generator() {
  const [mode, setMode] = useState<Mode>('password');
  const [password, setPassword] = useState<PasswordOptions>({
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: false,
  });
  const [passphrase, setPassphrase] = useState<PassphraseOptions>({
    words: 5,
    separator: 'hyphen',
    capitalize: false,
  });
  const [result, setResult] = useState<Generated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const noClasses =
    !password.lowercase && !password.uppercase && !password.digits && !password.symbols;

  const regenerate = useCallback(() => {
    if (mode === 'password' && noClasses) return;
    const request =
      mode === 'password' ? generator.password(password) : generator.passphrase(passphrase);
    request.then(
      (generated) => {
        setResult(generated);
        setError(null);
        setCopied(false);
      },
      (e: unknown) => setError(String(e)),
    );
  }, [mode, password, passphrase, noClasses]);

  useEffect(regenerate, [regenerate]);

  const copy = () => {
    if (!result) return;
    lock.copySecret(result.value).then(
      () => setCopied(true),
      (e: unknown) => setError(`Copy failed: ${String(e)}`),
    );
  };

  return (
    <section className="panel gen" aria-labelledby="generator-title">
      <h2 id="generator-title">Generate</h2>

      <div className="seg large" role="radiogroup" aria-label="Type">
        {(['password', 'passphrase'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
          >
            {m === 'password' ? 'Password' : 'Passphrase'}
          </button>
        ))}
      </div>

      <output className="gen-output" aria-live="polite">
        <SecretText value={result?.value ?? '\u00a0'} />
      </output>
      {result && (
        <StrengthMeter
          rating={ratingFromEntropy(result.entropyBits)}
          detail={`${Math.floor(result.entropyBits)} bits`}
        />
      )}
      <div className="actions">
        <button type="button" onClick={regenerate} disabled={mode === 'password' && noClasses}>
          <Icon name="refresh" size={13} />
          Regenerate
        </button>
        <button type="button" className="primary" onClick={copy} disabled={!result}>
          <Icon name="copy" size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {mode === 'password' ? (
        <fieldset>
          <label className="field">
            <span>Length {password.length}</span>
            <input
              type="range"
              min={PASSWORD_LENGTH.min}
              max={PASSWORD_LENGTH.max}
              value={password.length}
              onChange={(e) => setPassword({ ...password, length: Number(e.target.value) })}
            />
          </label>
          {CLASS_OPTIONS.map(([key, label]) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={password[key]}
                onChange={(e) => setPassword({ ...password, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={password.avoidAmbiguous}
              onChange={(e) => setPassword({ ...password, avoidAmbiguous: e.target.checked })}
            />
            Avoid look-alikes (0 O 1 I l)
          </label>
          {noClasses && <p role="alert">Pick at least one character type.</p>}
        </fieldset>
      ) : (
        <fieldset>
          <label className="field">
            <span>Words {passphrase.words}</span>
            <input
              type="range"
              min={PASSPHRASE_WORDS.min}
              max={PASSPHRASE_WORDS.max}
              value={passphrase.words}
              onChange={(e) => setPassphrase({ ...passphrase, words: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Separator</span>
            <select
              value={passphrase.separator}
              onChange={(e) =>
                setPassphrase({ ...passphrase, separator: e.target.value as Separator })
              }
            >
              {SEPARATORS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={passphrase.capitalize}
              onChange={(e) => setPassphrase({ ...passphrase, capitalize: e.target.checked })}
            />
            Capitalize words
          </label>
        </fieldset>
      )}

      <ErrorLine error={error} />
    </section>
  );
}

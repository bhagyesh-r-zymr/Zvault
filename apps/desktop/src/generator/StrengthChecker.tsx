import { useEffect, useRef, useState } from 'react';
import { generator, type Strength } from './api.js';
import { ratingFromScore } from './rating.js';
import { StrengthMeter } from './StrengthMeter.js';

const DEBOUNCE_MS = 150;

export function StrengthChecker() {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [strength, setStrength] = useState<Strength | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Drops replies to older keystrokes that arrive after newer ones.
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    if (password === '') {
      setStrength(null);
      return;
    }
    const timer = setTimeout(() => {
      generator.strength(password).then(
        (s) => {
          if (request !== latest.current) return;
          setStrength(s);
          setError(null);
        },
        (e: unknown) => setError(String(e)),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [password]);

  return (
    <section className="panel gen" aria-labelledby="strength-title">
      <h2 id="strength-title">Check a password</h2>
      <div className="actions" style={{ flexWrap: 'nowrap' }}>
        <input
          type={visible ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Type or paste a password"
          aria-label="Password to check"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" onClick={() => setVisible(!visible)}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {strength && (
        <>
          <StrengthMeter
            rating={ratingFromScore(strength.score)}
            detail={`cracked in ${strength.crackTimeOffline} offline`}
          />
          {strength.warning && <p className="warning">{strength.warning}</p>}
          {strength.suggestions.length > 0 && (
            <ul className="tips">
              {strength.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}

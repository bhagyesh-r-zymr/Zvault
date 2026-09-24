import { useEffect, useState } from 'react';
import { lock } from '../lock.js';
import { Icon } from '../ui/Icon.js';
import type { OtpCode } from './core.js';
import { formatCode, secondsLeft, type FetchedCode } from './countdown.js';
import './otp.css';

interface Props {
  /** Computes the current code in Rust (e.g. `() => sync.totpCode(itemId)`). */
  getCode: () => Promise<OtpCode | null>;
  /** Copies the code; defaults to the auto-clearing clipboard. */
  copy?: (text: string) => Promise<unknown>;
}

/**
 * The live one-time password of an item: the code, a countdown ring and a
 * copy button. It asks Rust for a new code when the current one runs out.
 */
export function OneTimePasswordCode({ getCode, copy = lock.copySecret }: Props) {
  const [fetched, setFetched] = useState<FetchedCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const left = fetched ? secondsLeft(fetched, now) : 0;
  const expired = fetched !== null && left === 0;

  useEffect(() => {
    if (fetched && !expired) return;
    let cancelled = false;
    getCode().then(
      (code) => {
        if (cancelled) return;
        setError(null);
        setFetched(code ? { code, fetchedAt: Date.now() } : null);
        setNow(Date.now());
      },
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [getCode, fetched, expired]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (error)
    return (
      <span role="alert" className="error">
        {error}
      </span>
    );
  if (!fetched) return null;

  const { code, period } = fetched.code;
  const fraction = left / period;
  const onCopy = () => {
    copy(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      (e: unknown) => setError(String(e)),
    );
  };

  return (
    <span className="otp-code">
      <code aria-label="One-time password" aria-live="polite">
        {formatCode(code)}
      </code>
      <svg
        className={`otp-ring${left <= 5 ? ' otp-ring-low' : ''}`}
        viewBox="0 0 36 36"
        role="img"
        aria-label={`${left} seconds left`}
      >
        <circle className="otp-ring-track" cx="18" cy="18" r="15.9" />
        <circle
          className="otp-ring-fill"
          cx="18"
          cy="18"
          r="15.9"
          pathLength={100}
          strokeDasharray={`${fraction * 100} 100`}
        />
        <text x="18" y="22" textAnchor="middle">
          {left}
        </text>
      </svg>
      <button type="button" className="small" onClick={onCopy}>
        {copied ? (
          <>
            <Icon name="check" size={13} /> Copied
          </>
        ) : (
          'Copy'
        )}
      </button>
    </span>
  );
}

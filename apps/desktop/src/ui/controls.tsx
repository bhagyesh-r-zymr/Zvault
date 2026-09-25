import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { lock } from '../lock.js';
import { Icon } from './Icon.js';

/** Colours digits and symbols so a secret can be read aloud without mistakes. */
export function SecretText({ value, masked = false }: { value: string; masked?: boolean }) {
  if (masked) {
    return (
      <span className="secret masked" aria-label="Hidden">
        {'•'.repeat(Math.min(Math.max(value.length, 12), 24))}
      </span>
    );
  }
  const parts: ReactNode[] = [];
  let run = '';
  let kind: 'a' | 'd' | 's' = 'a';
  const flush = () => {
    if (!run) return;
    parts.push(
      kind === 'a' ? (
        run
      ) : (
        <span key={parts.length} className={kind}>
          {run}
        </span>
      ),
    );
    run = '';
  };
  for (const ch of value) {
    const next = /[0-9]/.test(ch) ? 'd' : /[\p{L}\s]/u.test(ch) ? 'a' : 's';
    if (next !== kind) {
      flush();
      kind = next;
    }
    run += ch;
  }
  flush();
  return <span className="secret">{parts}</span>;
}

/**
 * Copies through the Rust core, which clears the clipboard after the
 * configured delay. Falls back to the web clipboard for non-secret values.
 * `value` can be a function, to decrypt the value only when it is copied.
 */
export function CopyButton({
  value,
  secret = true,
  label = 'Copy',
  className = 'small',
}: {
  value: string | (() => Promise<string>);
  secret?: boolean;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    try {
      const text = typeof value === 'function' ? await value() : value;
      if (secret) await lock.copySecret(text);
      else await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button type="button" className={className} disabled={!value} onClick={() => void copy()}>
      {state === 'copied' ? (
        <>
          <Icon name="check" size={13} /> Copied
        </>
      ) : state === 'failed' ? (
        'Copy failed'
      ) : (
        label
      )}
    </button>
  );
}

/** A modal sheet. Escape and the backdrop close it; focus moves inside on open. */
export function Sheet({
  title,
  subtitle,
  icon,
  onClose,
  children,
  width,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    // Listen on the window: focus can drop to <body> when a button inside
    // the sheet is replaced, and Escape should still close it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="sheet-head">
          {icon}
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <span className="row-sub">{subtitle}</span>}
          </div>
          <button type="button" className="icon ghost" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A row of mutually exclusive options. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  large = false,
}: {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  large?: boolean;
}) {
  return (
    <div className={large ? 'seg large' : 'seg'} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled on/off switch row. */
export function SwitchRow({
  title,
  detail,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  detail?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="row">
      <label className="row-main" htmlFor={id}>
        <span className="row-title">{title}</span>
        {detail && <span className="row-sub">{detail}</span>}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

/** Tile colours, as theme tokens so they can be tuned per light and dark mode. */
const TILE_COLORS = [
  'var(--tile-navy)',
  'var(--tile-indigo)',
  'var(--tile-orange)',
  'var(--tile-plum)',
  'var(--tile-denim)',
  'var(--tile-coral)',
  'var(--tile-green)',
  'var(--tile-violet)',
];

/** A letter tile for an item without an icon. The colour is stable per name. */
export function LetterTile({ name, size }: { name: string; size?: 'small' | 'large' }) {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = TILE_COLORS[hash % TILE_COLORS.length]!;
  return (
    <span
      className={size ? `tile ${size}` : 'tile'}
      style={{ background: bg, borderColor: bg, color: 'var(--tile-ink)' }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="alert">
      {error}
    </p>
  );
}

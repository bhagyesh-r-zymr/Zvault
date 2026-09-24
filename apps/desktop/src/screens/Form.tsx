import { useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../auth.js';

/** A form that disables itself while submitting and shows the error it throws. */
export function Form(props: {
  title: string;
  intro?: ReactNode;
  submitLabel: string;
  busyLabel?: string;
  onSubmit: () => Promise<void>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    props.onSubmit().then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false);
        setError(errorMessage(err));
      },
    );
  };

  return (
    <form className="card" onSubmit={submit}>
      <h1>{props.title}</h1>
      {props.intro && <p className="muted">{props.intro}</p>}
      <fieldset disabled={busy}>{props.children}</fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? (props.busyLabel ?? 'Working…') : props.submitLabel}
      </button>
      {props.footer && <div className="footer">{props.footer}</div>}
    </form>
  );
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  hint?: string;
  autoFocus?: boolean;
  inputMode?: 'numeric' | 'email' | 'text';
  maxLength?: number;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete ?? 'off'}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        required
      />
      {props.hint && <small className="muted">{props.hint}</small>}
    </label>
  );
}

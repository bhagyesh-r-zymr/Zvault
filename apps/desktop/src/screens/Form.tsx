import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../auth.js';
import { ErrorLine } from '../ui/controls.js';
import { BrandMark, Icon } from '../ui/Icon.js';

const SIGNUP_STEPS = ['Email', 'Verify', 'Password', 'Emergency Kit'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];

/** Progress bar across the four sign-up steps. */
export function SignupSteps({ current }: { current: SignupStep }) {
  const at = SIGNUP_STEPS.indexOf(current);
  return (
    <ol className="steps" aria-label={`Step ${at + 1} of ${SIGNUP_STEPS.length}`}>
      {SIGNUP_STEPS.map((s, i) => (
        <li
          key={s}
          data-state={i < at ? 'done' : i === at ? 'current' : 'todo'}
          aria-current={i === at ? 'step' : undefined}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}

/** The dotted-grid frame every signed-out screen sits in. */
export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth">
      <div className={wide ? 'auth-card wide' : 'auth-card'}>{children}</div>
      <span className="pill secure auth-badge">
        <Icon name="shield" size={13} strokeWidth={2.2} />
        End-to-end encrypted. Your master password never leaves this Mac.
      </span>
    </div>
  );
}

/** A signed-out form that disables itself while submitting and shows the error it throws. */
export function Form(props: {
  title: string;
  intro?: ReactNode;
  step?: SignupStep;
  above?: ReactNode;
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
    <AuthLayout>
      {props.step && <SignupSteps current={props.step} />}
      <div className="auth-top">
        <BrandMark size={props.step ? 52 : 68} />
        <h1>{props.title}</h1>
        {props.intro && <p>{props.intro}</p>}
        {props.above}
      </div>
      <form className="auth-form" onSubmit={submit}>
        <fieldset disabled={busy}>{props.children}</fieldset>
        <ErrorLine error={error} />
        <button type="submit" className="primary large block" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? (props.busyLabel ?? 'Working…') : props.submitLabel}
        </button>
      </form>
      {props.footer && <div className="auth-foot">{props.footer}</div>}
    </AuthLayout>
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
  mono?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className={props.mono ? 'mono' : undefined}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete ?? 'off'}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        required
      />
      {props.hint && <small>{props.hint}</small>}
    </div>
  );
}

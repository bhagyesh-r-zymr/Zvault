import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { createAccount, MIN_PASSWORD_LENGTH, passwordProblem } from '../auth.js';
import { Field, Form } from './Form.js';

export function SignupEmail(props: { onSent: (email: string) => void; onSignIn: () => void }) {
  const [email, setEmail] = useState('');
  return (
    <Form
      title="Create your Zvault account"
      intro="We'll email you a six-digit code to confirm your address."
      submitLabel="Send code"
      busyLabel="Sending…"
      onSubmit={async () => {
        const normalized = email.trim().toLowerCase();
        await api.signupStart(normalized);
        props.onSent(normalized);
      }}
      footer={
        <button type="button" className="link" onClick={props.onSignIn}>
          I already have an account
        </button>
      }
    >
      <Field
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        autoFocus
      />
    </Form>
  );
}

const RESEND_SECONDS = 60;

export function SignupCode(props: {
  email: string;
  onVerified: (signupToken: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  return (
    <Form
      title="Check your email"
      intro={
        <>
          Enter the code we sent to <strong>{props.email}</strong>. It expires in 15 minutes.
        </>
      }
      submitLabel="Verify"
      busyLabel="Checking…"
      onSubmit={async () => {
        const res = await api.signupVerify(props.email, code.replace(/\D/g, ''));
        props.onVerified(res.signupToken);
      }}
      footer={
        <>
          <button
            type="button"
            className="link"
            disabled={wait > 0}
            onClick={() => {
              setWait(RESEND_SECONDS);
              void api.signupStart(props.email);
            }}
          >
            {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
          </button>
          <button type="button" className="link" onClick={props.onBack}>
            Use a different email
          </button>
        </>
      }
    >
      <Field
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={setCode}
        autoFocus
      />
    </Form>
  );
}

export function SignupPassword(props: {
  email: string;
  signupToken: string;
  onCreated: (secretKey: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <Form
      title="Choose a master password"
      intro="It unlocks everything in Zvault. We never see it and can't reset it, so pick something long you'll remember."
      submitLabel="Create account"
      busyLabel="Generating your keys…"
      onSubmit={async () => {
        const problem = passwordProblem(password, confirm, props.email);
        if (problem) throw new Error(problem);
        props.onCreated(await createAccount(props.email, password, props.signupToken));
      }}
    >
      <Field
        label="Master password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few random words works well.`}
        autoFocus
      />
      <Field
        label="Confirm master password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
      />
    </Form>
  );
}

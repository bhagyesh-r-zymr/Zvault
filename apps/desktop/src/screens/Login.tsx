import { useState } from 'react';
import { ApiRequestError } from '../api.js';
import { needsTwoFactor, signIn, type Session, type TwoFactorChallenge } from '../auth.js';
import { ApiError, TwoFactorPrompt } from '../two-factor/index.js';
import { Field, Form } from './Form.js';

export function Login(props: {
  email?: string;
  secretKey?: string;
  onSignedIn: (session: Session) => void;
  onCreateAccount: () => void;
}) {
  const [email, setEmail] = useState(props.email ?? '');
  const [password, setPassword] = useState('');
  const [secretKey, setSecretKey] = useState(props.secretKey ?? '');
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);

  if (challenge) {
    return (
      <div className="card">
        <TwoFactorPrompt
          onSubmit={async (proof) => {
            try {
              props.onSignedIn(await challenge.complete(proof));
            } catch (e) {
              // The prompt explains 2FA errors from their codes.
              throw e instanceof ApiRequestError ? new ApiError(e.status, e.code, e.message) : e;
            }
          }}
          onCancel={() => {
            setChallenge(null);
            setPassword('');
          }}
        />
      </div>
    );
  }

  return (
    <Form
      title={props.email ? 'Welcome back' : 'Sign in to Zvault'}
      intro={
        props.email
          ? undefined
          : 'Use the email, Secret Key and master password from your Emergency Kit.'
      }
      above={
        props.email ? (
          <span className="account-chip">
            <span className="avatar">{props.email[0]?.toUpperCase()}</span>
            {props.email}
          </span>
        ) : undefined
      }
      submitLabel="Sign in"
      busyLabel="Unlocking…"
      onSubmit={async () => {
        const result = await signIn(email.trim().toLowerCase(), password, secretKey);
        if (needsTwoFactor(result)) setChallenge(result);
        else props.onSignedIn(result);
      }}
      footer={
        <button type="button" className="link" onClick={props.onCreateAccount}>
          Create an account
        </button>
      }
    >
      <Field
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="username"
        value={email}
        onChange={setEmail}
        autoFocus={!props.email}
      />
      <Field
        label="Secret Key"
        mono
        placeholder="Z1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        value={secretKey}
        onChange={setSecretKey}
        hint="It's on your Emergency Kit. You only type it once per device."
      />
      <Field
        label="Master password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        autoFocus={!!props.email}
      />
    </Form>
  );
}

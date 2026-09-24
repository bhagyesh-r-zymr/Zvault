import { useState } from 'react';
import { signIn, type Session } from '../auth.js';
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
        props.onSignedIn(await signIn(email.trim().toLowerCase(), password, secretKey));
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

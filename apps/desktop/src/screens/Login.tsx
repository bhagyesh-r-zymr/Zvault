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
      title="Sign in to Zvault"
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
        value={secretKey}
        onChange={setSecretKey}
        hint="From your Emergency Kit, e.g. Z1-XXXXXX-XXXXX-…"
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

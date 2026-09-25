import { useState } from 'react';
import { ApiRequestError } from '../api.js';
import {
  errorMessage,
  needsTwoFactor,
  signIn,
  type Session,
  type TwoFactorChallenge,
} from '../auth.js';
import { core, maskedSecretKey, type ImportedKit, type RememberedAccount } from '../core.js';
import { ApiError, TwoFactorPrompt } from '../two-factor/index.js';
import { ErrorLine } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { Field, Form } from './Form.js';

const normalize = (email: string) => email.trim().toLowerCase();

export function Login(props: {
  email?: string;
  secretKey?: string;
  /** The account whose Secret Key this Mac already remembers. */
  remembered?: RememberedAccount | null;
  onSignedIn: (session: Session) => void;
  onCreateAccount: () => void;
}) {
  const [email, setEmail] = useState(props.email ?? '');
  const [password, setPassword] = useState('');
  const [secretKey, setSecretKey] = useState(props.secretKey ?? '');
  const [kit, setKit] = useState<ImportedKit | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);
  /** The person chose to type a key instead of using the saved one. */
  const [typing, setTyping] = useState(false);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);

  const savedKeyId =
    props.remembered && normalize(email) === props.remembered.email
      ? props.remembered.secretKeyId
      : null;
  // A key typed during sign-up wins, then a picked kit, then the saved key.
  const held: SavedKeyProps | null = props.secretKey
    ? null
    : kit
      ? {
          secretKeyId: kit.secretKeyId,
          note:
            kit.email && normalize(kit.email) !== normalize(email)
              ? `Read from the Emergency Kit for ${kit.email}.`
              : 'Read from your Emergency Kit. Saved to this Mac after you sign in.',
          actionLabel: 'Type it instead',
          onAction: () => dropKit(),
        }
      : savedKeyId && !typing
        ? {
            secretKeyId: savedKeyId,
            note: 'Saved in this Mac’s Keychain.',
            actionLabel: 'Use a different key',
            onAction: () => setTyping(true),
          }
        : null;

  const chooseKit = () => {
    setKitError(null);
    core.importEmergencyKit().then(
      (read) => {
        if (!read) return;
        setKit(read);
        if (read.email && !email.trim()) setEmail(read.email);
      },
      (e: unknown) => setKitError(errorMessage(e)),
    );
  };

  const dropKit = () => {
    setKit(null);
    setTyping(true);
    void core.clearEmergencyKitImport();
  };

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
        const result = await signIn(normalize(email), password, held ? null : secretKey);
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
      {held ? (
        <SavedKey {...held} />
      ) : (
        <div className="field">
          <Field
            label="Secret Key"
            mono
            placeholder="Z1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            value={secretKey}
            onChange={setSecretKey}
            hint="It's on your Emergency Kit. This Mac remembers it after you sign in."
          />
          {!props.secretKey && (
            <small>
              <button type="button" className="link" onClick={chooseKit}>
                Choose your Emergency Kit PDF
              </button>{' '}
              to read it from the file instead.
            </small>
          )}
          <ErrorLine error={kitError} />
        </div>
      )}
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

interface SavedKeyProps {
  secretKeyId: string;
  note: string;
  actionLabel: string;
  onAction: () => void;
}

/** A Secret Key the app holds but never shows: only its public id. */
function SavedKey(props: SavedKeyProps) {
  return (
    <div className="field">
      <span>Secret Key</span>
      <div className="saved-key">
        <Icon name="key" size={15} />
        <span className="mono">{maskedSecretKey(props.secretKeyId)}</span>
        <Icon name="check" size={15} className="saved-key-check" />
      </div>
      <small>
        {props.note}{' '}
        <button type="button" className="link" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      </small>
    </div>
  );
}

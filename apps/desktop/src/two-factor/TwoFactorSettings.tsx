import type { TwoFactorStatusResponse } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { describeError, type TwoFactorApi } from './api.js';
import { RecoveryCodes } from './RecoveryCodes.js';
import { TwoFactorPrompt } from './TwoFactorPrompt.js';
import { TwoFactorSetup } from './TwoFactorSetup.js';

interface Props {
  api: TwoFactorApi;
  account: string;
}

type View =
  | { kind: 'overview' }
  | { kind: 'setup' }
  | { kind: 'confirm-disable' }
  | { kind: 'confirm-regenerate' }
  | { kind: 'new-codes'; codes: string[] };

/** Settings panel: status, turn on, new recovery codes, turn off. */
export function TwoFactorSettings({ api, account }: Props) {
  const [status, setStatus] = useState<TwoFactorStatusResponse | null>(null);
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.status().then(setStatus, (e: unknown) => setError(describeError(e)));
  }, [api]);

  useEffect(refresh, [refresh]);

  const back = () => {
    setView({ kind: 'overview' });
    refresh();
  };

  switch (view.kind) {
    case 'setup':
      return <TwoFactorSetup api={api} account={account} onEnabled={back} onCancel={back} />;
    case 'new-codes':
      return <RecoveryCodes codes={view.codes} account={account} onDone={back} />;
    case 'confirm-disable':
      return (
        <TwoFactorPrompt
          title="Turn off two-factor authentication"
          onSubmit={async (proof) => {
            await api.disable(proof);
            back();
          }}
          onCancel={back}
        />
      );
    case 'confirm-regenerate':
      return (
        <TwoFactorPrompt
          title="Get new recovery codes"
          onSubmit={async (proof) => {
            const { recoveryCodes } = await api.regenerateRecoveryCodes(proof);
            setView({ kind: 'new-codes', codes: recoveryCodes });
          }}
          onCancel={back}
        />
      );
    case 'overview':
      break;
  }

  return (
    <section aria-labelledby="tfa-settings-title">
      <h2 id="tfa-settings-title">Two-factor authentication</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {status && !status.totpEnabled && (
        <>
          <p>Off. Add a code from an authenticator app to every sign-in.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => setView({ kind: 'setup' })}>
              Turn on
            </button>
          </div>
        </>
      )}
      {status?.totpEnabled && (
        <>
          <p>
            On{status.enabledAt && ` since ${new Date(status.enabledAt).toLocaleDateString()}`}.{' '}
            {status.recoveryCodesRemaining} of 10 recovery codes left.
          </p>
          {status.recoveryCodesRemaining <= 3 && (
            <p className="warning">You’re running low on recovery codes. Get a new set.</p>
          )}
          <div className="actions">
            <button type="button" onClick={() => setView({ kind: 'confirm-regenerate' })}>
              New recovery codes
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => setView({ kind: 'confirm-disable' })}
            >
              Turn off
            </button>
          </div>
        </>
      )}
    </section>
  );
}

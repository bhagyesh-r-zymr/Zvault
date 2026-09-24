import type { TwoFactorStatusResponse } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { describeError, type TwoFactorApi } from './api.js';
import { Icon } from '../ui/Icon.js';
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
    <section aria-labelledby="tfa-settings-title" className="tfa">
      <h2 id="tfa-settings-title">Two-step sign-in</h2>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="panel panel-pad tfa-status">
        <span className={status?.totpEnabled ? 'tile tfa-on' : 'tile'}>
          <Icon name={status?.totpEnabled ? 'shieldCheck' : 'shield'} size={20} />
        </span>
        <div className="row-main">
          {status === null && !error && <span className="row-title">Checking…</span>}
          {status && !status.totpEnabled && (
            <>
              <span className="row-title">Two-step sign-in is off</span>
              <span className="row-sub">
                Add a code from an authenticator app to every sign-in.
              </span>
            </>
          )}
          {status?.totpEnabled && (
            <>
              <span className="row-title">Two-step sign-in is on</span>
              <span className={status.recoveryCodesRemaining <= 3 ? 'row-sub warning' : 'row-sub'}>
                Authenticator app
                {status.enabledAt &&
                  ` since ${new Date(status.enabledAt).toLocaleDateString()}`} ·{' '}
                {status.recoveryCodesRemaining} of 10 recovery codes left
                {status.recoveryCodesRemaining <= 3 && '. Get a new set soon.'}
              </span>
            </>
          )}
        </div>
        {status && !status.totpEnabled && (
          <button type="button" className="primary" onClick={() => setView({ kind: 'setup' })}>
            Turn on
          </button>
        )}
        {status?.totpEnabled && (
          <>
            <button type="button" onClick={() => setView({ kind: 'confirm-regenerate' })}>
              Recovery codes
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setView({ kind: 'confirm-disable' })}
            >
              Turn off
            </button>
          </>
        )}
      </div>
    </section>
  );
}

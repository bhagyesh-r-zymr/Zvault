import { CRYPTO_VERSION } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { core, type CoreInfo } from './core.js';
import { lock, useActivityReporter, type LockReason, type LockStatus } from './lock.js';
import { LockScreen } from './LockScreen.js';
import { LockSettingsPanel } from './LockSettingsPanel.js';

export function App() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [lockReason, setLockReason] = useState<LockReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    lock.status().then(setStatus, (e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    core.info().then(setInfo, (e: unknown) => setError(String(e)));
    refresh();
    const unlisten = lock.onLocked((reason) => {
      // Drop anything derived from the vault before showing the lock screen.
      setNotice(null);
      setLockReason(reason);
      refresh();
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [refresh]);

  const unlocked = status !== null && !status.locked;
  useActivityReporter(unlocked);

  const copyCheck = () => {
    const sample = crypto.randomUUID();
    lock.copySecret(sample).then(
      (secs) => setNotice(`Copied a test value. It will be cleared in ${secs} seconds.`),
      (e: unknown) => setNotice(String(e)),
    );
  };

  const mismatch = info !== null && info.cryptoVersion !== CRYPTO_VERSION;

  return (
    <main>
      <h1>Zvault</h1>
      {error && <p role="alert">Rust core unavailable: {error}</p>}
      {status?.locked && (
        <LockScreen
          status={status}
          reason={lockReason}
          onUnlocked={() => {
            setLockReason(null);
            refresh();
          }}
        />
      )}
      {unlocked && (
        <>
          <p>
            Unlocked as {status.accountId}
            {status.unlockMethod === 'touchId' && ' with Touch ID'}.{' '}
            <button type="button" onClick={() => void lock.lockNow()}>
              Lock now
            </button>
          </p>
          <LockSettingsPanel status={status} onChanged={refresh} />
          {import.meta.env.DEV && (
            <p>
              <button type="button" onClick={copyCheck}>
                Copy a test secret
              </button>{' '}
              {notice}
            </p>
          )}
          {info && (
            <dl>
              <dt>Crypto version</dt>
              <dd>
                {info.cryptoVersion}
                {mismatch && ' (does not match @zvault/shared)'}
              </dd>
              <dt>Key derivation</dt>
              <dd>{info.kdf}</dd>
              <dt>Encryption</dt>
              <dd>{info.aead}</dd>
            </dl>
          )}
        </>
      )}
    </main>
  );
}

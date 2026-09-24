import { CRYPTO_VERSION } from '@zvault/shared';
import { useEffect, useState } from 'react';
import { core, type CoreInfo } from './core.js';
import { Generator } from './generator/Generator.js';
import { StrengthChecker } from './generator/StrengthChecker.js';

export function App() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    core.info().then(setInfo, (e: unknown) => setError(String(e)));
  }, []);

  const mismatch = info !== null && info.cryptoVersion !== CRYPTO_VERSION;

  return (
    <main>
      <h1>Zvault</h1>
      <p>End-to-end encrypted password manager.</p>
      {error && <p role="alert">Rust core unavailable: {error}</p>}
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
      <Generator />
      <StrengthChecker />
    </main>
  );
}

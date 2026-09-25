import type { DeviceInfo } from '@zvault/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
// Not the `qrcode` package: it assigns `exports.toString`, which throws under
// Tauri's frozen prototypes.
import { renderSVG } from 'uqr';
import { Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { DevicesApiError } from './client.js';
import './devices.css';
import { groupCode, pairingCore, type PairingClient } from './pairing.js';

type Step =
  | { kind: 'starting' }
  | { kind: 'scan'; id: string; uri: string; qr: string; expiresAt: number }
  | { kind: 'confirm'; id: string; device: DeviceInfo; publicKey: string; code: string }
  | { kind: 'adding'; device: DeviceInfo }
  | { kind: 'done'; device: DeviceInfo }
  | { kind: 'failed'; message: string };

const POLL_MS = 1500;

/**
 * Shows a one-time QR code. When a phone scans it, both screens show the same
 * six-digit code, and the phone is signed in only after the person allows it.
 */
export function AddPhoneSheet({
  client,
  apiUrl,
  onClose,
  onAdded,
  onSignedOut,
}: {
  client: PairingClient;
  apiUrl: string;
  onClose: () => void;
  onAdded: () => void;
  onSignedOut: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const [showText, setShowText] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stepRef = useRef(step);
  stepRef.current = step;

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DevicesApiError && e.signedOut) return onSignedOut();
      setStep({
        kind: 'failed',
        message:
          e instanceof DevicesApiError
            ? e.message
            : typeof e === 'string'
              ? e
              : 'Could not reach Zvault. Try again.',
      });
    },
    [onSignedOut],
  );

  const start = useCallback(async () => {
    setStep({ kind: 'starting' });
    setShowText(false);
    try {
      const { claimToken } = await pairingCore.begin();
      const pairing = await client.create(claimToken);
      const uri = await pairingCore.qr(pairing.id, apiUrl);
      const svg = renderSVG(uri, { ecc: 'M', border: 1 });
      setStep({
        kind: 'scan',
        id: pairing.id,
        uri,
        qr: `data:image/svg+xml;base64,${btoa(svg)}`,
        expiresAt: Date.parse(pairing.expiresAt),
      });
    } catch (e) {
      fail(e);
    }
  }, [apiUrl, client, fail]);

  useEffect(() => {
    void start();
    return () => void pairingCore.cancel();
  }, [start]);

  // Wait for a phone to claim the QR code.
  useEffect(() => {
    if (step.kind !== 'scan') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void client.get(step.id).then(
        async (view) => {
          if (stepRef.current.kind !== 'scan' || view.status !== 'claimed') return;
          if (!view.device || !view.publicKey) return;
          const code = await pairingCore.code(view.publicKey);
          setStep({
            kind: 'confirm',
            id: step.id,
            device: view.device,
            publicKey: view.publicKey,
            code,
          });
        },
        (e: unknown) => {
          if (stepRef.current.kind === 'scan') fail(e);
        },
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, fail, step]);

  async function allow() {
    if (step.kind !== 'confirm') return;
    const { id, device, publicKey } = step;
    setStep({ kind: 'adding', device });
    try {
      await client.approve(id, await pairingCore.grant(publicKey));
      setStep({ kind: 'done', device });
      onAdded();
    } catch (e) {
      fail(e);
    }
  }

  async function deny() {
    if (step.kind !== 'confirm') return;
    try {
      await client.deny(step.id);
      await pairingCore.cancel();
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  const secondsLeft =
    step.kind === 'scan' ? Math.max(0, Math.round((step.expiresAt - now) / 1000)) : 0;
  const expired = step.kind === 'scan' && secondsLeft === 0;

  return (
    <Sheet
      title="Add a phone"
      subtitle="Sign in to Zvault on your phone without typing anything."
      icon={<Icon name="device" size={18} />}
      onClose={onClose}
      width={460}
    >
      <div className="pairing">
        {step.kind === 'starting' && (
          <p aria-busy="true" className="muted">
            Making a one-time QR code…
          </p>
        )}

        {step.kind === 'scan' && (
          <>
            <ol className="pairing-steps secondary">
              <li>Open Zvault on your phone.</li>
              <li>Tap “Sign in with QR code” and point the camera here.</li>
            </ol>
            <div className={`pairing-qr${expired ? ' expired' : ''}`}>
              <img className="qr" src={step.qr} alt="QR code to sign in on your phone" />
              {expired && (
                <button type="button" className="primary" onClick={() => void start()}>
                  <Icon name="refresh" size={13} /> New code
                </button>
              )}
            </div>
            <p className="muted pairing-timer" aria-live="polite">
              {expired
                ? 'This code has expired.'
                : `Waiting for your phone. Works once, for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`}
            </p>
            {showText ? (
              <code className="pairing-text">{step.uri}</code>
            ) : (
              <button type="button" className="link" onClick={() => setShowText(true)}>
                Can’t scan? Show it as text
              </button>
            )}
          </>
        )}

        {step.kind === 'confirm' && (
          <>
            <p>
              <strong>{step.device.name}</strong> wants to sign in to your account.
            </p>
            <div className="pairing-code mono" aria-label={`Code ${step.code.split('').join(' ')}`}>
              {groupCode(step.code)}
            </div>
            <p className="secondary">
              Allow it only if your phone shows the same code. It will be able to see all your items
              and projects.
            </p>
            <div className="actions">
              <button type="button" onClick={() => void deny()}>
                Deny
              </button>
              <button type="button" className="primary" onClick={() => void allow()}>
                Allow
              </button>
            </div>
          </>
        )}

        {step.kind === 'adding' && (
          <p aria-busy="true" className="muted">
            Adding {step.device.name}…
          </p>
        )}

        {step.kind === 'done' && (
          <>
            <p className="pairing-done">
              <Icon name="check" size={16} /> {step.device.name} is signed in.
            </p>
            <p className="secondary">
              It now shows in your devices. Sign it out there if you lose it.
            </p>
            <div className="actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {step.kind === 'failed' && (
          <>
            <p role="alert" className="alert">
              {step.message}
            </p>
            <div className="actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" onClick={() => void start()}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

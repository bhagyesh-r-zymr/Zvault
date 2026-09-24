import { useState } from 'react';
import { lock, type LockSettings, type LockStatus } from './lock.js';
import { ErrorLine, Segmented, SwitchRow } from './ui/controls.js';

interface Props {
  status: LockStatus;
  onChanged: () => void;
}

const IDLE_MINUTES = [1, 5, 10, 30, 60];
const CLIPBOARD_SECONDS = [30, 90, 300];

const withCurrent = (options: number[], current: number) =>
  options.includes(current) ? options : [...options, current].sort((a, b) => a - b);

const minutes = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const seconds = (s: number) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export function LockSettingsPanel({ status, onChanged }: Props) {
  const [draft, setDraft] = useState<LockSettings>(status.settings);
  const [error, setError] = useState<string | null>(null);

  const save = (next: LockSettings) => {
    setDraft(next);
    setError(null);
    lock.setSettings(next).then(onChanged, (e: unknown) => setError(String(e)));
  };

  const toggleTouchId = () => {
    setError(null);
    const action = status.touchId.enrolled ? lock.disableTouchId : lock.enableTouchId;
    action().then(onChanged, (e: unknown) => setError(String(e)));
  };

  return (
    <section
      aria-labelledby="lock-settings-title"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <h2 id="lock-settings-title">Locking</h2>
      <div className="panel rows">
        <SwitchRow
          title="Unlock with Touch ID"
          detail={
            status.touchId.available
              ? 'Asks for your master password every 14 days'
              : 'Touch ID is not available on this Mac'
          }
          checked={status.touchId.enrolled}
          disabled={!status.touchId.available}
          onChange={toggleTouchId}
        />
        <div className="row">
          <div className="row-main">
            <span className="row-title">Lock after inactivity</span>
            <span className="row-sub">Zvault wipes its keys from memory when it locks</span>
          </div>
          <Segmented
            label="Lock after inactivity"
            value={draft.idleTimeoutMins}
            onChange={(v) => save({ ...draft, idleTimeoutMins: v })}
            options={withCurrent(IDLE_MINUTES, draft.idleTimeoutMins).map((m) => ({
              value: m,
              label: minutes(m),
            }))}
          />
        </div>
        <SwitchRow
          title="Lock when the Mac sleeps"
          checked={draft.lockOnSleep}
          onChange={(v) => save({ ...draft, lockOnSleep: v })}
        />
        <SwitchRow
          title="Lock when the screen locks"
          checked={draft.lockOnScreenLock}
          onChange={(v) => save({ ...draft, lockOnScreenLock: v })}
        />
        <div className="row">
          <div className="row-main">
            <span className="row-title">Clear copied secrets</span>
            <span className="row-sub">Removes passwords from the clipboard after</span>
          </div>
          <Segmented
            label="Clear copied secrets after"
            value={draft.clipboardClearSecs}
            onChange={(v) => save({ ...draft, clipboardClearSecs: v })}
            options={withCurrent(CLIPBOARD_SECONDS, draft.clipboardClearSecs).map((s) => ({
              value: s,
              label: seconds(s),
            }))}
          />
        </div>
      </div>
      <ErrorLine error={error} />
    </section>
  );
}

import { useId } from 'react';

interface Props {
  mode: 'code' | 'recovery';
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Input for a 6-digit TOTP code or an `XXXXX-XXXXX` recovery code. */
export function CodeInput({ mode, value, onChange, disabled = false }: Props) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{mode === 'code' ? '6-digit code' : 'Recovery code'}</label>
      <input
        id={id}
        className="code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode={mode === 'code' ? 'numeric' : 'text'}
        maxLength={mode === 'code' ? 7 : 11}
        placeholder={mode === 'code' ? '123456' : 'XXXXX-XXXXX'}
      />
    </div>
  );
}

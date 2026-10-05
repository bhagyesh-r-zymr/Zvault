import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { generator } from './api.js';
import { StrengthChecker } from './StrengthChecker.js';

const strength = {
  score: 1,
  guessesLog10: 3,
  crackTimeOffline: '2 minutes',
  crackTimeOnline: 'days',
  warning: 'This is a common password',
  suggestions: ['Add another word'],
};

describe('StrengthChecker', () => {
  it('rates a typed password and toggles visibility', async () => {
    const calls = mockCore({ check_password_strength: strength });
    const user = userEvent.setup();
    render(<StrengthChecker />);
    const input = screen.getByLabelText('Password to check');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, 'hunter2');
    expect(await screen.findByText(/cracked in 2 minutes offline/)).toBeInTheDocument();
    expect(screen.getByText('Weak')).toBeInTheDocument();
    expect(screen.getByText('This is a common password')).toBeInTheDocument();
    expect(screen.getByText('Add another word')).toBeInTheDocument();
    expect(calls).toHaveBeenLastCalledWith('check_password_strength', {
      password: 'hunter2',
      userInputs: [],
    });

    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(input).toHaveAttribute('type', 'text');

    await user.clear(input);
    expect(screen.queryByText(/cracked in/)).not.toBeInTheDocument();
  });

  it('shows an error when the check fails', async () => {
    mockCore({
      check_password_strength: () => {
        throw new Error('boom');
      },
    });
    const user = userEvent.setup();
    render(<StrengthChecker />);
    await user.type(screen.getByLabelText('Password to check'), 'a');
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});

describe('generator api', () => {
  it('passes options through to the core', async () => {
    const calls = mockCore({
      generate_password: { value: 'a', entropyBits: 1 },
      generate_passphrase: { value: 'b', entropyBits: 2 },
      check_password_strength: strength,
    });
    await generator.password({
      length: 8,
      lowercase: true,
      uppercase: false,
      digits: false,
      symbols: false,
      avoidAmbiguous: false,
    });
    await generator.passphrase({ words: 3, separator: 'space', capitalize: false });
    await generator.strength('pw', ['me']);
    expect(calls).toHaveBeenCalledWith('check_password_strength', {
      password: 'pw',
      userInputs: ['me'],
    });
    expect(calls).toHaveBeenCalledTimes(3);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockCore } from '../test/tauri.js';
import { Generator } from './Generator.js';

describe('Generator', () => {
  it('generates a password, regenerates and copies it', async () => {
    let n = 0;
    const calls = mockCore({
      generate_password: () => ({ value: n++ ? 'bravo' : 'alpha', entropyBits: 120.7 }),
      copy_secret: 30,
    });
    const user = userEvent.setup();
    render(<Generator />);
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText(/Strong/)).toBeInTheDocument();
    expect(screen.getByText(/120 bits/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByText('bravo')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Copy/ }));
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
    expect(calls).toHaveBeenCalledWith('copy_secret', { text: 'bravo' });
  });

  it('applies option changes to the request', async () => {
    const calls = mockCore({ generate_password: { value: 'x', entropyBits: 10 } });
    const user = userEvent.setup();
    render(<Generator />);
    await screen.findByText('x');
    await user.click(screen.getByLabelText('A–Z'));
    await user.click(screen.getByLabelText(/look-alikes/));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '32' } });
    await waitFor(() =>
      expect(calls).toHaveBeenLastCalledWith('generate_password', {
        options: {
          length: 32,
          lowercase: true,
          uppercase: false,
          digits: true,
          symbols: true,
          avoidAmbiguous: true,
        },
      }),
    );
  });

  it('asks for at least one character class', async () => {
    const calls = mockCore({ generate_password: { value: 'x', entropyBits: 10 } });
    const user = userEvent.setup();
    render(<Generator />);
    await screen.findByText('x');
    for (const label of ['a–z', 'A–Z', '0–9', '!#$%'])
      await user.click(screen.getByLabelText(label));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one character type.');
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeDisabled();
    const before = calls.mock.calls.length;
    await user.click(screen.getByLabelText('a–z'));
    await waitFor(() => expect(calls.mock.calls.length).toBeGreaterThan(before));
  });

  it('switches to passphrase mode', async () => {
    const calls = mockCore({
      generate_password: { value: 'x', entropyBits: 10 },
      generate_passphrase: { value: 'correcthorse', entropyBits: 70 },
    });
    const user = userEvent.setup();
    render(<Generator />);
    await user.click(screen.getByRole('radio', { name: 'Passphrase' }));
    expect(await screen.findByText('correcthorse')).toBeInTheDocument();
    expect(screen.getByText(/Good/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'digit');
    await user.click(screen.getByLabelText('Capitalize words'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '7' } });
    await waitFor(() =>
      expect(calls).toHaveBeenLastCalledWith('generate_passphrase', {
        options: { words: 7, separator: 'digit', capitalize: true },
      }),
    );
  });

  it('shows errors from generation and copying', async () => {
    mockCore({
      generate_password: () => {
        throw new Error('rng down');
      },
    });
    render(<Generator />);
    expect(await screen.findByText(/rng down/)).toBeInTheDocument();
  });

  it('reports a failed copy', async () => {
    mockCore({
      generate_password: { value: 'x', entropyBits: 10 },
      copy_secret: () => {
        throw new Error('no clipboard');
      },
    });
    const user = userEvent.setup();
    render(<Generator />);
    await screen.findByText('x');
    await user.click(screen.getByRole('button', { name: /Copy/ }));
    expect(await screen.findByText(/Copy failed: .*no clipboard/)).toBeInTheDocument();
  });
});

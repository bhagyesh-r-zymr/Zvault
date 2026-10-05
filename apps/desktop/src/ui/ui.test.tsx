import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockCore } from '../test/tauri.js';
import {
  CopyButton,
  ErrorLine,
  LetterTile,
  Segmented,
  SecretText,
  Sheet,
  SwitchRow,
} from './controls.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { BrandMark, Icon, type IconName } from './Icon.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretText', () => {
  it('colours digits and symbols apart from letters', () => {
    const { container } = render(<SecretText value="ab 12 !? cd" />);
    expect(container.querySelector('.d')).toHaveTextContent('12');
    expect(container.querySelector('.s')).toHaveTextContent('!?');
    expect(container.querySelector('.secret')).toHaveTextContent('ab 12 !? cd');
  });

  it('masks with a length between 12 and 24', () => {
    const { rerender } = render(<SecretText value="x" masked />);
    expect(screen.getByLabelText('Hidden').textContent).toHaveLength(12);
    rerender(<SecretText value={'x'.repeat(100)} masked />);
    expect(screen.getByLabelText('Hidden').textContent).toHaveLength(24);
  });
});

describe('CopyButton', () => {
  it('copies a secret through the Rust core and confirms', async () => {
    const calls = mockCore({ copy_secret: 30 });
    render(<CopyButton value="hunter2" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(calls).toHaveBeenCalledWith('copy_secret', { text: 'hunter2' });
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('resolves a lazy value and uses the web clipboard for non-secrets', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<CopyButton value={() => Promise.resolve('plain')} secret={false} label="Copy it" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(writeText).toHaveBeenCalledWith('plain');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a failure, then resets', async () => {
    mockCore({
      copy_secret: () => {
        throw new Error('no');
      },
    });
    render(<CopyButton value="x" />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Copy')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('is disabled without a value', () => {
    render(<CopyButton value="" />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('Sheet', () => {
  it('closes with Escape, the backdrop and the close button', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet
        title="Title"
        subtitle="Sub"
        icon={<i data-testid="ic" />}
        onClose={onClose}
        width={400}
      >
        <p>body</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Title' })).toHaveFocus();
    expect(screen.getByText('Sub')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByText('body'));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(container.querySelector('.sheet-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('renders as a popover and restores focus on unmount', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const { container, unmount } = render(
      <Sheet title="T" onClose={() => undefined} popover>
        x
      </Sheet>,
    );
    expect(container.querySelector('.sheet.popover')).not.toBeNull();
    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe('Segmented and SwitchRow', () => {
  it('selects an option', async () => {
    function Harness() {
      const [v, setV] = useState(1);
      return (
        <Segmented
          label="Pick"
          large
          value={v}
          onChange={setV}
          options={[
            { value: 1, label: 'One' },
            { value: 2, label: 'Two' },
          ]}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'One' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Two' }));
    expect(screen.getByRole('radio', { name: 'Two' })).toBeChecked();
  });

  it('toggles a switch and honours disabled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SwitchRow title="Sw" detail="det" checked={false} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('switch', { name: /Sw/ }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<SwitchRow title="Sw" checked disabled onChange={onChange} />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

describe('LetterTile, ErrorLine, icons', () => {
  it('derives a stable letter and colour from the name', () => {
    const { container, rerender } = render(<LetterTile name=" github" size="large" />);
    const first = container.querySelector('.tile.large') as HTMLElement;
    expect(first).toHaveTextContent('G');
    const bg = first.style.background;
    rerender(<LetterTile name=" github" />);
    expect((container.querySelector('.tile') as HTMLElement).style.background).toBe(bg);
    rerender(<LetterTile name="" />);
    expect(container).toHaveTextContent('?');
  });

  it('shows an error only when there is one', () => {
    const { rerender } = render(<ErrorLine error={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<ErrorLine error="bad" />);
    expect(screen.getByRole('alert')).toHaveTextContent('bad');
  });

  it('draws an icon and the brand mark', () => {
    const { container } = render(
      <>
        <Icon name={'key' satisfies IconName} size={20} strokeWidth={3} data-x="1" />
        <BrandMark />
        <BrandMark size={68} />
      </>,
    );
    expect(container.querySelectorAll('svg')).toHaveLength(3);
    expect(container.querySelector('svg')).toHaveAttribute('width', '20');
  });
});

describe('ErrorBoundary', () => {
  it('shows the crash and recovers on Try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Bomb() {
      if (broken) throw new Error('kaboom');
      return <p>fine</p>;
    }
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  core: { saveEmergencyKit: vi.fn(), discardEmergencyKit: vi.fn() },
}));

const { core } = await import('./core.js');
const { EmergencyKitStep } = await import('./EmergencyKitStep.js');

beforeEach(() => vi.resetAllMocks());

describe('EmergencyKitStep', () => {
  it('only offers to continue after the kit is saved and confirmed', async () => {
    vi.mocked(core.saveEmergencyKit).mockResolvedValue(true);
    vi.mocked(core.discardEmergencyKit).mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<EmergencyKitStep email="a@b.co" onDone={onDone} />);
    expect(screen.queryByRole('button', { name: 'Continue to sign in' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Save Emergency Kit PDF/ }));
    expect(core.saveEmergencyKit).toHaveBeenCalledWith('a@b.co');
    expect(await screen.findByRole('button', { name: /Save another copy/ })).toBeInTheDocument();
    const cont = screen.getByRole('button', { name: 'Continue to sign in' });
    expect(cont).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(cont);
    expect(core.discardEmergencyKit).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('stays on the save step when the dialog is cancelled', async () => {
    vi.mocked(core.saveEmergencyKit).mockResolvedValue(false);
    render(<EmergencyKitStep email="a@b.co" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Save Emergency Kit PDF/ }));
    expect(screen.getByRole('button', { name: /Save Emergency Kit PDF/ })).toBeEnabled();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows a save failure', async () => {
    vi.mocked(core.saveEmergencyKit).mockRejectedValue('disk full');
    render(<EmergencyKitStep email="a@b.co" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Save Emergency Kit PDF/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  });

  it('does not continue if the staged key cannot be discarded', async () => {
    vi.mocked(core.saveEmergencyKit).mockResolvedValue(true);
    vi.mocked(core.discardEmergencyKit).mockRejectedValue(new Error('locked'));
    const onDone = vi.fn();
    render(<EmergencyKitStep email="a@b.co" onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: /Save Emergency Kit PDF/ }));
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('locked');
    expect(onDone).not.toHaveBeenCalled();
  });
});

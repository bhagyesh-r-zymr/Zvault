/* eslint-disable @typescript-eslint/unbound-method -- test doubles */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeSync, renderWithProjects } from '../test/projectsHarness.js';
import { ApiError } from './api.js';
import { NewProjectSheet } from './NewProjectSheet.js';

function setup(sync = fakeSync()) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  renderWithProjects(<NewProjectSheet onClose={onClose} onCreated={onCreated} />, { sync });
  return { sync, onClose, onCreated };
}

describe('NewProjectSheet', () => {
  it('creates a project and previews its reference', async () => {
    const user = userEvent.setup();
    const { sync, onCreated } = setup();
    expect(screen.getByText(/zv:\/\/project\//)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Payments API');
    expect(screen.getByText(/zv:\/\/payments-api\//)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-project-id'));
    expect(sync.createProject).toHaveBeenCalledWith('Payments API');
  });

  it('requires a name with a letter or digit', async () => {
    const user = userEvent.setup();
    const { sync } = setup();
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the project a name.');
    await user.type(screen.getByLabelText('Name'), '!!!');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least one letter or digit');
    expect(sync.createProject).not.toHaveBeenCalled();
  });

  it('shows a readable error when creating fails, and closes on Cancel', async () => {
    const user = userEvent.setup();
    const sync = fakeSync({}, { createProject: vi.fn().mockRejectedValue(new ApiError(400)) });
    const { onClose } = setup(sync);
    await user.type(screen.getByLabelText('Name'), 'X');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('turned this down');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

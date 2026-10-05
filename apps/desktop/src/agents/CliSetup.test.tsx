import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { settleOnUnmount } from '../test/settle.js';
import { mockCore } from '../test/tauri.js';
import { BrowserSetup } from './BrowserSetup.js';
import { CLAUDE_GUIDE, ClaudeSetup, CliInstall } from './CliSetup.js';

const status = (over: Record<string, unknown> = {}) => ({
  bundled: true,
  installedAt: null,
  onPath: false,
  command: 'ln -s zv ~/bin/zv',
  ...over,
});

settleOnUnmount();

describe('CliInstall', () => {
  it('offers to install a bundled zv and then shows where it is', async () => {
    const user = userEvent.setup();
    let installed: string | null = null;
    const calls = mockCore({
      cli_status: () => status({ installedAt: installed, onPath: true }),
      cli_install: () => {
        installed = '/Users/me/.local/bin/zv';
        return { path: installed, onPath: true, pathLine: null };
      },
    });
    render(<CliInstall />);
    await user.click(await screen.findByRole('button', { name: 'Install CLI' }));
    expect(await screen.findByText('zv is installed')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/.local/bin/zv')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reinstall' })).toBeInTheDocument();
    expect(calls).toHaveBeenCalledWith('cli_install', { admin: false });
  });

  it('suggests a PATH line and installs for all users', async () => {
    const user = userEvent.setup();
    const calls = mockCore({
      cli_status: status({ installedAt: '/Users/me/bin/zv' }),
      cli_install: { path: '/usr/local/bin/zv', onPath: false, pathLine: 'export PATH="/x:$PATH"' },
    });
    render(<CliInstall />);
    expect(await screen.findByText('Not on your PATH yet')).toBeInTheDocument();
    expect(screen.getByText('export PATH="/Users/me/bin:$PATH"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install for all' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('cli_install', { admin: true }));
    expect(await screen.findByText('export PATH="/x:$PATH"')).toBeInTheDocument();
  });

  it('shows the download command for builds without zv', async () => {
    mockCore({ cli_status: status({ bundled: false, command: null }) });
    render(<CliInstall />);
    expect(await screen.findByText(/does not include zv/)).toBeInTheDocument();
    expect(screen.getByText(/releases\/latest\/download\/zv-macos-universal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install CLI' })).not.toBeInTheDocument();
  });

  it('copes with a status failure and shows install errors but not cancellation', async () => {
    const user = userEvent.setup();
    let failWith: unknown = new Error('disk full');
    mockCore({
      cli_status: () => status(),
      cli_install: () => {
        throw failWith;
      },
    });
    render(<CliInstall />);
    await user.click(await screen.findByRole('button', { name: 'Install CLI' }));
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    failWith = 'cancelled';
    await user.click(screen.getByRole('button', { name: 'Install CLI' }));
    await waitFor(() => expect(screen.queryByText('disk full')).not.toBeInTheDocument());
  });

  it('renders without status when the command fails', async () => {
    mockCore({ cli_status: () => Promise.reject(new Error('x')) });
    render(<CliInstall />);
    expect(await screen.findByText('Install the zv command')).toBeInTheDocument();
  });
});

describe('ClaudeSetup', () => {
  it('shows the instructions to paste', () => {
    render(<ClaudeSetup />);
    expect(screen.getByText(/Zvault secrets/)).toBeInTheDocument();
    expect(CLAUDE_GUIDE).toContain('zv agent pair --name "Claude Code"');
    expect(screen.getByRole('button', { name: 'Copy instructions' })).toBeInTheDocument();
  });
});

describe('BrowserSetup', () => {
  const states: [Record<string, unknown> | null, RegExp][] = [
    [
      { bundled: true, browsers: ['Chrome', 'Arc'], extensionId: 'x' },
      /Registered with Chrome, Arc/,
    ],
    [{ bundled: true, browsers: [], extensionId: 'x' }, /Install Chrome, Brave/],
    [{ bundled: false, browsers: [], extensionId: 'x' }, /does not include zv/],
  ];
  it.each(states)('describes %j', async (s, text) => {
    mockCore({ browser_extension_status: s });
    render(<BrowserSetup />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('is ready when registered', async () => {
    mockCore({
      browser_extension_status: { bundled: true, browsers: ['Chrome'], extensionId: 'x' },
    });
    render(<BrowserSetup />);
    expect(
      await screen.findByText('Zvault is ready for the browser extension'),
    ).toBeInTheDocument();
  });

  it('keeps checking text when status fails', async () => {
    mockCore({ browser_extension_status: () => Promise.reject(new Error('x')) });
    render(<BrowserSetup />);
    expect(await screen.findByText('Checking your browsers…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'zvault-chrome-extension.zip' })).toBeInTheDocument();
  });
});

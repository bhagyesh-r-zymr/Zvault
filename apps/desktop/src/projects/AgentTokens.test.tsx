/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- test doubles */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, NOW, project } from '../test/projectsFixtures.js';
import { mockCore } from '../test/tauri.js';
import { AgentTokens, TokensContext } from './AgentTokens.js';
import { TeamError } from './teamApi.js';
import type { TokensApi, TokensCore } from './tokensApi.js';

const view = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  name: 'GitHub deploy',
  environmentIds: [IDS.prod],
  createdBy: { id: IDS.me, email: 'me@acme.dev' },
  createdAt: NOW,
  expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  lastUsedAt: null,
  stale: false,
  ...over,
});

function setup(
  opts: {
    tokens?: ReturnType<typeof view>[];
    api?: Partial<Record<keyof TokensApi, unknown>>;
    core?: TokensCore;
    lockAll?: boolean;
    noCtx?: boolean;
  } = {},
) {
  const api = {
    list: vi.fn(async () => opts.tokens ?? []),
    create: vi.fn(async (_p: string, body: { name: string }) => view({ name: body.name })),
    revoke: vi.fn(async () => undefined),
    ...opts.api,
  };
  const p = project();
  p.environments[1]!.inheritsFrom = IDS.dev;
  if (opts.lockAll) p.environments.forEach((e) => (e.locked = true));
  const core: TokensCore = opts.core ?? {
    issue: vi.fn(async () => ({
      id: crypto.randomUUID(),
      verifier: 'v',
      encryptedProjectKey: {} as never,
      environments: [],
      token: 'zvt_abc123',
    })),
  };
  const ui = <AgentTokens project={p} keyVersions={{ [IDS.prod]: 2 }} />;
  const out = render(
    opts.noCtx ? (
      ui
    ) : (
      <TokensContext.Provider value={{ api: api as unknown as TokensApi, core }}>
        {ui}
      </TokensContext.Provider>
    ),
  );
  return { api, core, ...out };
}

beforeEach(() => {
  mockCore({});
});

describe('AgentTokens', () => {
  it('renders nothing without a tokens provider', () => {
    const { container } = setup({ noCtx: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('explains an empty list', async () => {
    setup();
    expect(await screen.findByText(/lets a CI job or a cloud AI agent/)).toBeInTheDocument();
  });

  it('lists tokens with their details and revokes one', async () => {
    const user = userEvent.setup();
    const stale = view({
      name: 'Old one',
      stale: true,
      environmentIds: [IDS.prod, IDS.dev],
      lastUsedAt: new Date().toISOString(),
    });
    const fresh = view();
    const { api } = setup({ tokens: [fresh, stale] });
    expect(await screen.findByText('GitHub deploy')).toBeInTheDocument();
    expect(screen.getByText('Re-issue needed')).toBeInTheDocument();
    expect(screen.getByText(/falls back to Development/)).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
    expect(screen.getByText(/used just now/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith(IDS.project, fresh.id));
    await waitFor(() => expect(screen.queryByText('GitHub deploy')).toBeNull());
  });

  it('shows load and revoke errors', async () => {
    const user = userEvent.setup();
    const t = view();
    const { api } = setup({
      tokens: [t],
      api: { revoke: vi.fn().mockRejectedValue(new TeamError(500, 'revoke broke')) },
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('revoke broke');
    expect(api.revoke).toHaveBeenCalled();
  });

  it('shows a load failure', async () => {
    setup({ api: { list: vi.fn().mockRejectedValue(new TeamError(500, 'cannot list')) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot list');
  });

  it('disables New token when no environment key is held', async () => {
    setup({ lockAll: true });
    expect(await screen.findByRole('button', { name: /New token/ })).toBeDisabled();
  });

  it('makes a token and shows it once', async () => {
    const user = userEvent.setup();
    const { api, core } = setup();
    await user.click(await screen.findByRole('button', { name: /New token/ }));
    expect(screen.getByRole('button', { name: 'Make token' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), '  CI  ');
    expect(screen.getByText(/falling back to Development/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Expires after'), '7');
    await user.click(screen.getByRole('button', { name: 'Make token' }));
    expect(await screen.findByText('Copy your token')).toBeInTheDocument();
    expect(screen.getByText('zvt_abc123')).toBeInTheDocument();
    expect(core.issue).toHaveBeenCalledWith(IDS.project, [
      { environmentId: IDS.prod, keyVersion: 2 },
      { environmentId: IDS.dev, keyVersion: 1 },
    ]);
    const body = (api.create as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { name: string };
    expect(body.name).toBe('CI');
    expect(screen.getByText(/zv run --env-from zv:\/\/payments\/production/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Copy your token')).toBeNull();
    expect(await screen.findByText('CI')).toBeInTheDocument();
  });

  it('lets the environment be picked and cancelled', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: /New token/ }));
    await user.click(screen.getByRole('button', { name: 'Development' }));
    expect(screen.getByText('zv://payments/development', { selector: 'code' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Read-only access for CI and cloud agents')).toBeNull();
  });

  it('shows an error when making the token fails', async () => {
    const user = userEvent.setup();
    const core: TokensCore = { issue: vi.fn().mockRejectedValue(new Error('no key')) };
    setup({ core });
    await user.click(await screen.findByRole('button', { name: /New token/ }));
    await user.type(screen.getByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Make token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no key');
  });
});

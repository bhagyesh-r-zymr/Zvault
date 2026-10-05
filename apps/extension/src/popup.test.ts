// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: any) => unknown;
let handler: Handler;
let sent: any[];
let pairingListener: (msg: unknown) => void;
let tabs: { id?: number }[];

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const text = () => document.getElementById('app')!.textContent ?? '';
const state = () => document.getElementById('state')!;
const buttons = () => Array.from(document.querySelectorAll('button'));
const btn = (label: string) => buttons().find((b) => b.textContent === label)!;

async function load(h: Handler) {
  handler = h;
  vi.resetModules();
  await import('./popup.js');
  await flush();
}

const login = (over = {}) => ({
  id: 'l1',
  title: 'Example Site',
  username: 'me@x.com',
  url: 'https://example.com',
  hasTotp: false,
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = '<span id="state"></span><main id="app"></main>';
  sent = [];
  tabs = [{ id: 4 }];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (req: any) => {
        sent.push(req);
        return handler(req);
      }),
      onMessage: { addListener: (l: typeof pairingListener) => (pairingListener = l) },
    },
    tabs: { query: vi.fn(async () => tabs) },
  });
});
afterEach(() => vi.unstubAllGlobals());

const status = (v: object) => ({
  ok: true,
  value: { running: true, locked: false, paired: true, ...v },
});

describe('popup status screens', () => {
  it('asks to install when the host is missing', async () => {
    await load(() => ({ ok: false, code: 'notInstalled', message: '' }));
    expect(state().textContent).toBe('Not connected');
    expect(text()).toContain('Zvault for Mac is needed');
  });

  it('shows other failures as an error', async () => {
    await load(() => ({ ok: false, code: 'timeout', message: 'x' }));
    expect(document.querySelector('.error')!.textContent).toBe('Nobody answered in Zvault.');
  });

  it('asks to open Zvault when it is closed', async () => {
    await load(() => status({ running: false }));
    expect(state().textContent).toBe('Zvault closed');
    expect(text()).toContain('Open Zvault');
  });

  it('shows the pairing code while waiting, spaced in two groups', async () => {
    await load(() => status({ paired: false, pairingCode: '123456' }));
    expect(document.querySelector('.pair-code')!.textContent).toBe('123 456');
  });

  it('leaves odd-length codes as they are when pushed from the background', async () => {
    await load(() => status({ paired: false, pairingCode: null }));
    pairingListener({ type: 'pairingCode', code: '1234' });
    expect(document.querySelector('.pair-code')!.textContent).toBe('1234');
    pairingListener({ type: 'other' });
    expect(document.querySelector('.pair-code')!.textContent).toBe('1234');
  });

  it('connects the browser, and shows the failure above the refreshed state', async () => {
    let paired = false;
    let pairOk = false;
    await load((req) => {
      if (req.type === 'pair') {
        return pairOk
          ? ((paired = true), { ok: true, value: { paired: true } })
          : { ok: false, code: 'denied', message: '' };
      }
      return paired ? status({ locked: true }) : status({ paired: false });
    });
    btn('Connect to Zvault').click();
    await flush();
    expect(app().firstElementChild!.textContent).toBe('You declined in Zvault.');
    pairOk = true;
    btn('Connect to Zvault').click();
    await flush();
    expect(state().textContent).toBe('Locked');
  });

  it('shows paused', async () => {
    await load(() => status({ paused: true }));
    expect(state().className).toContain('locked');
    expect(text()).toContain('Paused in Zvault');
  });

  it('unlocks and re-checks', async () => {
    let locked = true;
    await load((req) => {
      if (req.type === 'unlock') {
        locked = false;
        return { ok: true, value: null };
      }
      if (req.type === 'tabLogins')
        return { ok: true, value: { url: 'https://a.com', logins: [] } };
      return status({ locked });
    });
    btn('Unlock Zvault').click();
    await flush();
    expect(state().textContent).toBe('Unlocked');
    expect(sent.map((r) => r.type)).toContain('unlock');
  });
});

const app = () => document.getElementById('app')!;

describe('popup login list', () => {
  const base = (extra: (req: any) => unknown) => (req: any) =>
    req.type === 'status' ? status({ name: 'Chrome' }) : extra(req);

  it('lists logins for the tab and shows the site without www', async () => {
    await load(
      base(() => ({
        ok: true,
        value: {
          url: 'https://www.example.com/x',
          logins: [login(), login({ id: 'l2', title: 'one', username: '' })],
        },
      })),
    );
    expect(document.querySelector('.site b')!.textContent).toBe('example.com');
    const rows = document.querySelectorAll('.login');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.tile')!.textContent).toBe('ES');
    expect(rows[1]!.querySelector('.tile')!.textContent).toBe('ON');
    expect(rows[1]!.querySelector('.sub')!.textContent).toBe('No user name');
    expect(document.querySelector('footer')!.textContent).toContain('Chrome');
  });

  it('says so when no logins match, and when the tab is not a website', async () => {
    await load(base(() => ({ ok: true, value: { url: 'https://a.com', logins: [] } })));
    expect(text()).toContain('No logins saved for this website.');
    await load(base(() => ({ ok: false, code: 'noForm', message: '' })));
    expect(text()).toContain('Open a website to fill a login.');
    await load(base(() => ({ ok: false, code: 'locked', message: '' })));
    expect(document.querySelector('.error')!.textContent).toBe('Zvault is locked.');
  });

  it('shows only the footer when there is no active tab', async () => {
    tabs = [{}];
    await load(base(() => ({ ok: true, value: null })));
    expect(document.querySelector('footer')).not.toBeNull();
    expect(document.querySelector('.login')).toBeNull();
  });

  it('fills and closes the popup, or shows why not', async () => {
    const close = vi.fn();
    vi.stubGlobal('close', close);
    let fillOk = false;
    await load(
      base((req) => {
        if (req.type === 'tabFill')
          return fillOk ? { ok: true, value: null } : { ok: false, code: 'noForm', message: '' };
        return { ok: true, value: { url: 'https://a.com', logins: [login()] } };
      }),
    );
    btn('Fill').click();
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('.error')!.textContent).toBe('No login form on this page.');
    fillOk = true;
    btn('Fill').click();
    await flush();
    expect(close).toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({ type: 'tabFill', tabId: 4, item: 'l1', otpOnly: false });
  });

  it('copies a code and shows the time left', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let r: any = { ok: true, value: { otp: '123456', otpRemaining: 12 } };
    await load(
      base((req) =>
        req.type === 'tabCode'
          ? r
          : { ok: true, value: { url: 'https://a.com', logins: [login({ hasTotp: true })] } },
      ),
    );
    btn('Code').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('123456');
    expect(document.querySelector('.login .sub')!.textContent).toBe('Copied 123 456 · 12s left');

    r = { ok: true, value: { otp: null, otpRemaining: null } };
    btn('Code').click();
    await flush();
    r = { ok: false, code: 'locked', message: '' };
    btn('Code').click();
    await flush();
    expect(document.querySelector('.error')!.textContent).toBe('Zvault is locked.');
  });

  it('copies a code even if the clipboard refuses, and omits a zero timer', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    });
    await load(
      base((req) =>
        req.type === 'tabCode'
          ? { ok: true, value: { otp: '1234567', otpRemaining: 0 } }
          : { ok: true, value: { url: 'https://a.com', logins: [login({ hasTotp: true })] } },
      ),
    );
    btn('Code').click();
    await flush();
    expect(document.querySelector('.login .sub')!.textContent).toBe('Copied 1234567');
  });

  it('disconnects and starts over', async () => {
    await load(base(() => ({ ok: true, value: { url: 'https://a.com', logins: [] } })));
    sent.length = 0;
    btn('Disconnect').click();
    await flush();
    expect(sent.map((r) => r.type).slice(0, 2)).toEqual(['unpair', 'status']);
  });
});

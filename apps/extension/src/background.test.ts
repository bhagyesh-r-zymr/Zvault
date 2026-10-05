/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('./host.js', () => ({
  Host: class {
    request = request;
  },
}));

type Sender = Record<string, unknown>;
type MsgListener = (msg: unknown, sender: Sender, respond: (r: unknown) => void) => boolean;

const EXT = 'chrome-extension://abc/';
const store = new Map<string, unknown>();
let onMessage: MsgListener;
let onCommand: (command: string, tab?: { id?: number }) => void;
let onRemoved: (tabId: number) => void;
let tabsGet: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;
let runtimeSend: ReturnType<typeof vi.fn>;
let openPopup: ReturnType<typeof vi.fn>;
let storageSet: ReturnType<typeof vi.fn>;

function stubChrome() {
  store.clear();
  tabsGet = vi.fn();
  sendMessage = vi.fn().mockResolvedValue(true);
  runtimeSend = vi.fn().mockResolvedValue(undefined);
  openPopup = vi.fn().mockResolvedValue(undefined);
  storageSet = vi.fn(async (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) store.set(k, v);
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'abc',
      getURL: (p: string) => EXT + p,
      sendMessage: runtimeSend,
      onMessage: { addListener: (l: MsgListener) => (onMessage = l) },
    },
    commands: { onCommand: { addListener: (l: typeof onCommand) => (onCommand = l) } },
    tabs: {
      get: tabsGet,
      sendMessage,
      onRemoved: { addListener: (l: typeof onRemoved) => (onRemoved = l) },
    },
    action: { openPopup },
    storage: {
      session: {
        set: storageSet,
        get: vi.fn(async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {})),
        remove: vi.fn(async (k: string | string[]) => {
          for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
        }),
      },
    },
  });
}

function call(msg: unknown, sender: Sender): Promise<any> {
  return new Promise((resolve) => {
    const r = onMessage(msg, { id: 'abc', ...sender }, resolve);
    expect(r).toBe(true);
  });
}

const page = (over: Sender = {}) => ({
  url: 'https://example.com/login',
  frameId: 0,
  tab: { id: 7, url: 'https://example.com/login' },
  ...over,
});
const popup = { url: EXT + 'popup.html' };

beforeEach(async () => {
  vi.resetModules();
  request.mockReset();
  stubChrome();
  await import('./background.js');
});
afterEach(() => vi.unstubAllGlobals());

describe('sender checks', () => {
  it('ignores other extensions', () => {
    expect(onMessage({ type: 'status' }, { id: 'evil' }, () => {})).toBe(false);
  });

  it('refuses popup-only requests from a page and page-only ones from the popup', async () => {
    expect((await call({ type: 'pair' }, page())).code).toBe('badRequest');
    expect((await call({ type: 'tabLogins', tabId: 1 }, page())).code).toBe('badRequest');
    expect((await call({ type: 'logins' }, popup)).code).toBe('badRequest');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses top-frame-only requests from a subframe', async () => {
    for (const type of ['saveOffer', 'save', 'dismissSave']) {
      expect((await call({ type }, page({ frameId: 3 }))).code).toBe('badRequest');
    }
  });

  it('reports handler exceptions as an error result', async () => {
    request.mockRejectedValue(new Error('boom'));
    expect(await call({ type: 'logins' }, page())).toEqual({
      ok: false,
      code: 'error',
      message: 'boom',
    });
    request.mockRejectedValue('str');
    expect((await call({ type: 'logins' }, page())).message).toBe('str');
  });
});

describe('status and pairing', () => {
  it('adds the pairing code to the status', async () => {
    request.mockResolvedValue({ ok: true, value: { running: true } });
    const r = await call({ type: 'status' }, popup);
    expect(r).toEqual({ ok: true, value: { running: true, pairingCode: null } });
  });

  it('keeps the code during pairing, forwards it to the popup and clears it after', async () => {
    let finish!: (v: unknown) => void;
    request.mockImplementation((_m: unknown, onEvent?: (e: unknown) => void) => {
      if (onEvent) {
        onEvent({ event: 'other' });
        onEvent({ event: 'pairingCode', code: 123 });
        onEvent({ event: 'pairingCode', code: '111222' });
      }
      return new Promise((res) => (finish = res));
    });
    const pairing = call({ type: 'pair' }, popup);
    await vi.waitFor(() => expect(runtimeSend).toHaveBeenCalledTimes(1));
    expect(runtimeSend).toHaveBeenCalledWith({ type: 'pairingCode', code: '111222' });
    expect(request.mock.calls[0]![0]).toMatchObject({ type: 'pair' });
    expect(request.mock.calls[0]![0].name).toMatch(/^Zvault for /);

    request.mockResolvedValueOnce({ ok: true, value: { running: true } });
    const status = await call({ type: 'status' }, popup);
    expect(status.value.pairingCode).toBe('111222');

    finish({ ok: true, value: {} });
    await pairing;
    request.mockResolvedValueOnce({ ok: true, value: { running: true } });
    expect((await call({ type: 'status' }, popup)).value.pairingCode).toBeNull();
  });

  it('names the browser from user agent brands', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: {
        brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }],
      },
    });
    request.mockResolvedValue({ ok: true, value: {} });
    await call({ type: 'pair' }, popup);
    expect(request.mock.calls[0]![0].name).toBe('Zvault for Chrome');
  });

  it('forwards unpair and unlock', async () => {
    request.mockResolvedValue({ ok: true, value: {} });
    await call({ type: 'unpair' }, popup);
    await call({ type: 'unlock' }, popup);
    expect(request.mock.calls.map((c) => c[0].type)).toEqual(['unpair', 'unlock']);
  });
});

describe('logins and fill from a page', () => {
  it('sends the browser-reported frame and top addresses', async () => {
    request.mockResolvedValue({ ok: true, value: { logins: [{ id: 'a' }] } });
    const r = await call({ type: 'logins' }, page());
    expect(r).toEqual({ ok: true, value: [{ id: 'a' }] });
    expect(request).toHaveBeenCalledWith({
      type: 'logins',
      url: 'https://example.com/login',
      topUrl: 'https://example.com/login',
    });
  });

  it('uses the tab url as top url for subframes and passes failures through', async () => {
    request.mockResolvedValue({ ok: false, code: 'locked', message: 'x' });
    const r = await call(
      { type: 'logins' },
      page({
        url: 'https://pay.example.net/f',
        frameId: 4,
        tab: { id: 7, url: 'https://shop.test/' },
      }),
    );
    expect(r.code).toBe('locked');
    expect(request.mock.calls[0]![0]).toMatchObject({
      url: 'https://pay.example.net/f',
      topUrl: 'https://shop.test/',
    });
  });

  it('rejects non-http pages', async () => {
    for (const type of ['logins', 'fill']) {
      const r = await call({ type, item: 'a', otpOnly: false }, page({ url: 'file:///x' }));
      expect(r.code).toBe('badRequest');
    }
    expect((await call({ type: 'logins' }, { frameId: 0 })).code).toBe('badRequest');
  });

  it('remembers a full fill with a code, and reports it as last filled', async () => {
    request.mockResolvedValue({
      ok: true,
      value: { fill: { username: 'u', password: 'p', otp: '1' } },
    });
    await call({ type: 'fill', item: 'it1', otpOnly: false }, page());
    expect((await call({ type: 'lastFilled' }, page())).value).toBe('it1');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await call({ type: 'lastFilled' }, page())).value).toBeNull();
    vi.useRealTimers();
  });

  it('does not remember otp-only fills or fills without a code', async () => {
    request.mockResolvedValue({ ok: true, value: { fill: { otp: '1' } } });
    await call({ type: 'fill', item: 'a', otpOnly: true }, page());
    request.mockResolvedValue({ ok: true, value: { fill: { otp: null } } });
    await call({ type: 'fill', item: 'a', otpOnly: false }, page());
    expect(store.size).toBe(0);
    expect((await call({ type: 'lastFilled' }, page({ tab: undefined }))).value).toBeNull();
  });
});

describe('popup requests', () => {
  it('lists logins for a tab, but only on http(s) pages', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/a' });
    request.mockResolvedValue({ ok: true, value: { logins: [] } });
    expect(await call({ type: 'tabLogins', tabId: 1 }, popup)).toEqual({
      ok: true,
      value: { url: 'https://example.com/a', logins: [] },
    });
    expect(request.mock.calls[0]![0].topUrl).toBeNull();

    tabsGet.mockResolvedValue({ url: 'chrome://settings' });
    expect((await call({ type: 'tabLogins', tabId: 1 }, popup)).code).toBe('noForm');
    tabsGet.mockRejectedValue(new Error('gone'));
    expect((await call({ type: 'tabCode', tabId: 1, item: 'a' }, popup)).code).toBe('noForm');
    expect((await call({ type: 'tabFill', tabId: 1, item: 'a', otpOnly: false }, popup)).code).toBe(
      'noForm',
    );
  });

  it('returns the current code for a login', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/a' });
    request.mockResolvedValue({
      ok: true,
      value: { fill: { username: 'u', password: '', otp: '123456', otpRemaining: 9 } },
    });
    expect(await call({ type: 'tabCode', tabId: 1, item: 'a' }, popup)).toEqual({
      ok: true,
      value: { otp: '123456', otpRemaining: 9 },
    });
    expect(request.mock.calls[0]![0].otpOnly).toBe(true);
  });

  it('fills a tab, binding the fill to the origin it was approved for', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/a?q=1' });
    const fill = { username: 'u', password: 'p', otp: '5', otpRemaining: 3 };
    request.mockResolvedValue({ ok: true, value: { fill } });
    const r = await call({ type: 'tabFill', tabId: 9, item: 'it', otpOnly: false }, popup);
    expect(r).toEqual({ ok: true, value: null });
    expect(sendMessage).toHaveBeenCalledWith(
      9,
      { type: 'fillNow', origin: 'https://example.com', fill, otpOnly: false },
      { frameId: 0 },
    );
    expect(store.get('filled:9')).toMatchObject({ item: 'it' });
  });

  it('reports no form when the page does not take the fill, and passes host errors', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/' });
    request.mockResolvedValue({ ok: true, value: { fill: { otp: null } } });
    sendMessage.mockRejectedValue(new Error('no receiver'));
    expect((await call({ type: 'tabFill', tabId: 1, item: 'a', otpOnly: false }, popup)).code).toBe(
      'noForm',
    );
    sendMessage.mockResolvedValue(false);
    expect((await call({ type: 'tabFill', tabId: 1, item: 'a', otpOnly: true }, popup)).code).toBe(
      'noForm',
    );
    request.mockResolvedValue({ ok: false, code: 'denied', message: 'no' });
    expect((await call({ type: 'tabFill', tabId: 1, item: 'a', otpOnly: true }, popup)).code).toBe(
      'denied',
    );
  });
});

describe('saving typed logins', () => {
  const typed = (over: Sender = {}) => ({
    type: 'typed',
    username: ' me@x.com ',
    password: 'pw',
    ...over,
  });

  it('rejects empty passwords and non-string input', async () => {
    expect((await call(typed({ password: '' }), page())).code).toBe('badRequest');
    expect((await call(typed({ username: 5 }), page())).code).toBe('badRequest');
  });

  it('rejects pages that cannot be saved', async () => {
    expect((await call(typed(), page({ url: 'about:blank' }))).code).toBe('badRequest');
    expect((await call(typed(), page({ tab: {} }))).code).toBe('badRequest');
  });

  it('keeps a new login pending and tells the top frame to show the banner', async () => {
    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    const r = await call(typed(), page({ url: 'https://www.example.com/login' }));
    expect(r).toEqual({ ok: true, value: null });
    expect(request.mock.calls[0]![0]).toMatchObject({ type: 'saveCheck', username: 'me@x.com' });
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'offerSave', offer: { host: 'example.com', username: 'me@x.com', update: null } },
      { frameId: 0 },
    );
    expect((await call({ type: 'saveOffer' }, page())).value).toMatchObject({
      host: 'example.com',
    });
  });

  it('offers an update for a changed password', async () => {
    request.mockResolvedValue({
      ok: true,
      value: { check: { state: 'update', item: 'i1', title: 'Example' } },
    });
    await call(typed(), page());
    expect((await call({ type: 'saveOffer' }, page())).value.update).toBe('Example');
    request.mockResolvedValue({ ok: true, value: { message: 'Saved' } });
    await call({ type: 'save' }, page());
    expect(request.mock.calls.at(-1)![0]).toMatchObject({
      type: 'save',
      item: 'i1',
      password: 'pw',
    });
  });

  it('says nothing when already saved or when Zvault cannot check', async () => {
    request.mockResolvedValue({ ok: true, value: { check: { state: 'saved' } } });
    expect((await call(typed(), page())).ok).toBe(true);
    request.mockResolvedValue({ ok: false, code: 'locked', message: '' });
    expect((await call(typed(), page())).ok).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('fills in a user name remembered from the previous page of the same site only', async () => {
    await call({ type: 'typedUsername', username: ' first@x.com ' }, page());
    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    await call(typed({ username: '' }), page({ url: 'https://example.com/password' }));
    expect(request.mock.calls[0]![0].username).toBe('first@x.com');

    await call(typed({ username: '' }), page({ url: 'https://other.test/password' }));
    expect(request.mock.calls[1]![0].username).toBe('');
  });

  it('validates a user name sent alone', async () => {
    for (const username of ['', '   ', 'x'.repeat(513), 7]) {
      const r = await call({ type: 'typedUsername', username }, page());
      expect(r.code).toBe('badRequest');
    }
    expect((await call({ type: 'typedUsername', username: 'a' }, page({ tab: {} }))).code).toBe(
      'badRequest',
    );
    expect(store.size).toBe(0);
  });

  it('answers saveOffer with nothing when there is no tab or nothing pending', async () => {
    expect((await call({ type: 'saveOffer' }, page({ tab: {} }))).value).toBeNull();
    expect((await call({ type: 'saveOffer' }, page())).value).toBeNull();
  });

  it('drops a pending save after two minutes', async () => {
    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    await call(typed(), page());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);
    expect((await call({ type: 'save' }, page())).code).toBe('badRequest');
    vi.useRealTimers();
  });

  it('keeps the pending save after a retryable failure and drops it on success or denial', async () => {
    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    await call(typed(), page());
    request.mockResolvedValue({ ok: false, code: 'timeout', message: 't' });
    expect((await call({ type: 'save' }, page())).code).toBe('timeout');
    expect(store.has('save:7')).toBe(true);
    request.mockResolvedValue({ ok: false, code: 'denied', message: 'd' });
    await call({ type: 'save' }, page());
    expect(store.has('save:7')).toBe(false);

    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    await call(typed(), page());
    request.mockResolvedValue({ ok: true, value: { message: 'Saved' } });
    expect(await call({ type: 'save' }, page())).toEqual({ ok: true, value: { message: 'Saved' } });
    expect(store.has('save:7')).toBe(false);
  });

  it('refuses save without a tab, and dismiss drops the pending entry', async () => {
    expect((await call({ type: 'save' }, page({ tab: {} }))).code).toBe('badRequest');
    request.mockResolvedValue({ ok: true, value: { check: { state: 'new' } } });
    await call(typed(), page());
    await call({ type: 'dismissSave' }, page());
    expect(store.has('save:7')).toBe(false);
    expect((await call({ type: 'dismissSave' }, page({ tab: {} }))).ok).toBe(true);
  });
});

describe('browser events', () => {
  it('clears per-tab state when a tab closes', async () => {
    store.set('filled:3', 1);
    store.set('save:3', 1);
    store.set('user:3', 1);
    onRemoved(3);
    await vi.waitFor(() => expect(store.size).toBe(0));
  });

  it('fills the only login for the page on the shortcut', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/' });
    request
      .mockResolvedValueOnce({ ok: true, value: { logins: [{ id: 'only' }] } })
      .mockResolvedValueOnce({ ok: true, value: { fill: { otp: null } } });
    onCommand('fill-login', { id: 5 });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(request.mock.calls[1]![0]).toMatchObject({ type: 'fill', item: 'only' });
  });

  it('opens the popup when there is not exactly one login', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/' });
    request.mockResolvedValue({ ok: true, value: { logins: [{ id: 'a' }, { id: 'b' }] } });
    onCommand('fill-login', { id: 5 });
    await vi.waitFor(() => expect(openPopup).toHaveBeenCalled());
  });

  it('ignores other commands, missing tabs and non-web tabs', async () => {
    onCommand('other', { id: 5 });
    onCommand('fill-login', {});
    onCommand('fill-login', undefined);
    tabsGet.mockResolvedValue({ url: 'about:blank' });
    onCommand('fill-login', { id: 5 });
    await new Promise((r) => setTimeout(r, 10));
    expect(request).not.toHaveBeenCalled();
    expect(openPopup).not.toHaveBeenCalled();
  });
});

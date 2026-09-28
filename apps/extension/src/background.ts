/**
 * The service worker: the only part of the extension that talks to `zv`.
 *
 * Content scripts ask for the logins of the frame they run in; the address
 * sent to Zvault is the one the browser reports for that frame and its tab,
 * never one the page could supply. Zvault checks each login's websites
 * against it before listing or filling anything.
 */

import { Host } from './host.js';
import type { Fill, FillNow, Login, Request, Result, Status } from './messages.js';

const host = new Host();

/** A login filled in a tab, so its code can be offered on the next page. */
const LAST_FILLED_MS = 10 * 60 * 1000;

function fail<T>(code: 'noForm' | 'badRequest', message: string): Result<T> {
  return { ok: false, code, message };
}

function map<A, B>(r: Result<A>, f: (a: A) => B): Result<B> {
  return r.ok ? { ok: true, value: f(r.value) } : r;
}

/** The addresses Zvault matches: the frame's own and its tab's. */
function pageOf(sender: chrome.runtime.MessageSender) {
  const url = sender.url;
  const top = sender.tab?.url;
  if (!url || !/^https?:/.test(url)) return null;
  return { url, topUrl: sender.frameId === 0 ? url : (top ?? null) };
}

async function tabUrl(tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.url && /^https?:/.test(tab.url) ? tab.url : null;
}

async function remember(tabId: number | undefined, item: string) {
  if (tabId === undefined) return;
  await chrome.storage.session
    .set({ [`filled:${tabId}`]: { item, at: Date.now() } })
    .catch(() => undefined);
}

async function lastFilled(tabId: number | undefined): Promise<string | null> {
  if (tabId === undefined) return null;
  const key = `filled:${tabId}`;
  type Entry = { item: string; at: number } | undefined;
  const got: Record<string, Entry> = await chrome.storage.session
    .get<Record<string, Entry>>(key)
    .catch(() => ({}));
  const entry = got[key];
  return entry && Date.now() - entry.at < LAST_FILLED_MS ? entry.item : null;
}

let pairingCode: string | null = null;

async function logins(url: string, topUrl: string | null): Promise<Result<Login[]>> {
  const r = await host.request<{ logins: Login[] }>({ type: 'logins', url, topUrl });
  return map(r, (v) => v.logins);
}

async function fill(
  url: string,
  topUrl: string | null,
  item: string,
  otpOnly: boolean,
): Promise<Result<Fill>> {
  const r = await host.request<{ fill: Fill }>({ type: 'fill', item, url, topUrl, otpOnly });
  return map(r, (v) => v.fill);
}

/** Requests only the popup may make, and those only a page's content script may. */
const POPUP_ONLY = new Set<Request['type']>(['pair', 'unpair', 'tabLogins', 'tabFill', 'tabCode']);
const PAGE_ONLY = new Set<Request['type']>(['logins', 'fill', 'lastFilled']);

async function handle(msg: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts report the page's address; the popup its own.
  const fromPage = !sender.url?.startsWith(chrome.runtime.getURL(''));
  if ((fromPage && POPUP_ONLY.has(msg.type)) || (!fromPage && PAGE_ONLY.has(msg.type))) {
    return fail('badRequest', 'Not allowed from here.');
  }
  switch (msg.type) {
    case 'status':
      return map(await host.request<Status & Record<string, unknown>>({ type: 'status' }), (v) => ({
        ...v,
        pairingCode,
      }));
    case 'pair': {
      const r = await host.request({ type: 'pair', name: browserName() }, (event) => {
        if (event.event !== 'pairingCode' || typeof event.code !== 'string') return;
        pairingCode = event.code;
        chrome.runtime.sendMessage({ type: 'pairingCode', code: event.code }).catch(() => {});
      });
      pairingCode = null;
      return r;
    }
    case 'unpair':
      return host.request({ type: 'unpair' });
    case 'unlock':
      return host.request({ type: 'unlock' });
    case 'logins': {
      const page = pageOf(sender);
      if (!page) return fail('badRequest', 'This page cannot be filled.');
      return logins(page.url, page.topUrl);
    }
    case 'fill': {
      const page = pageOf(sender);
      if (!page) return fail('badRequest', 'This page cannot be filled.');
      const r = await fill(page.url, page.topUrl, msg.item, msg.otpOnly);
      if (r.ok && !msg.otpOnly && r.value.otp) await remember(sender.tab?.id, msg.item);
      return r;
    }
    case 'lastFilled':
      return { ok: true, value: await lastFilled(sender.tab?.id) };
    case 'tabLogins': {
      const url = await tabUrl(msg.tabId);
      if (!url) return fail('noForm', 'Zvault fills logins on websites.');
      return map(await logins(url, null), (list) => ({ url, logins: list }));
    }
    case 'tabFill': {
      const url = await tabUrl(msg.tabId);
      if (!url) return fail('noForm', 'Zvault fills logins on websites.');
      const r = await fill(url, null, msg.item, msg.otpOnly);
      if (!r.ok) return r;
      const now: FillNow = {
        type: 'fillNow',
        origin: new URL(url).origin,
        fill: r.value,
        otpOnly: msg.otpOnly,
      };
      const filled = (await chrome.tabs
        .sendMessage(msg.tabId, now, { frameId: 0 })
        .catch(() => false)) as boolean;
      if (!filled)
        return fail('noForm', 'No login form on this page. Click into it and try again.');
      if (!msg.otpOnly && r.value.otp) await remember(msg.tabId, msg.item);
      return { ok: true, value: null };
    }
    case 'tabCode': {
      const url = await tabUrl(msg.tabId);
      if (!url) return fail('noForm', 'Zvault fills logins on websites.');
      return map(await fill(url, null, msg.item, true), (f) => ({
        otp: f.otp,
        otpRemaining: f.otpRemaining,
      }));
    }
  }
}

/** A name for the pairing prompt: "Chrome", "Brave", "Edge"… */
function browserName(): string {
  const brands =
    (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData
      ?.brands ?? [];
  const brand = brands
    .map((b) => b.brand)
    .find((b) => !/not.?a.?brand|chromium/i.test(b))
    ?.replace(/^Google /, '');
  return `Zvault for ${brand ?? 'Chrome'}`;
}

chrome.runtime.onMessage.addListener((msg: Request, sender, respond) => {
  // Only this extension's own pages and content scripts reach here, but a
  // content script runs inside pages, so every request is checked above.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(respond, (e: unknown) =>
    respond({ ok: false, code: 'error', message: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});

/** Command-Shift-L: fill the only login saved for the page, or show the choice. */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'fill-login' || tab?.id === undefined) return;
  const tabId = tab.id;
  void (async () => {
    const url = await tabUrl(tabId);
    if (!url) return;
    const r = await logins(url, null);
    if (r.ok && r.value.length === 1) {
      await handle(
        { type: 'tabFill', tabId, item: r.value[0]!.id, otpOnly: false },
        { url: chrome.runtime.getURL('') },
      );
    } else {
      await chrome.action.openPopup().catch(() => undefined);
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`filled:${tabId}`).catch(() => undefined);
});

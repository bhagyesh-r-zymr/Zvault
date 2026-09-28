/**
 * The service worker: the only part of the extension that talks to `zv`.
 *
 * Content scripts ask for the logins of the frame they run in; the address
 * sent to Zvault is the one the browser reports for that frame and its tab,
 * never one the page could supply. Zvault checks each login's websites
 * against it before listing or filling anything.
 */

import { Host } from './host.js';
import type {
  Fill,
  FillNow,
  Login,
  OfferSave,
  Request,
  Result,
  SaveCheck,
  SaveOffer,
  Status,
} from './messages.js';

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

/**
 * A typed login waiting for the person to save it: kept in session storage,
 * which stays in memory and out of reach of content scripts, and dropped
 * after a couple of minutes.
 */
interface Pending {
  url: string;
  topUrl: string | null;
  username: string;
  password: string;
  item: string | null;
  offer: SaveOffer;
  at: number;
}

const PENDING_MS = 2 * 60 * 1000;
/** A user name sent alone, for the password page that follows it. */
const USERNAME_MS = 10 * 60 * 1000;

async function sessionGet<T>(key: string): Promise<T | undefined> {
  const got: Record<string, T | undefined> = await chrome.storage.session
    .get<Record<string, T | undefined>>(key)
    .catch(() => ({}));
  return got[key];
}

async function pending(tabId: number): Promise<Pending | null> {
  const p = await sessionGet<Pending>(`save:${tabId}`);
  return p && Date.now() - p.at < PENDING_MS ? p : null;
}

async function dropPending(tabId: number) {
  await chrome.storage.session.remove(`save:${tabId}`).catch(() => undefined);
}

async function typed(
  sender: chrome.runtime.MessageSender,
  username: string,
  password: string,
): Promise<Result<null>> {
  const page = pageOf(sender);
  const tabId = sender.tab?.id;
  if (!page || tabId === undefined) return fail('badRequest', 'This page cannot be saved.');
  const site = new URL(page.url).origin;
  if (!username) {
    const earlier = await sessionGet<{ username: string; site: string; at: number }>(
      `user:${tabId}`,
    );
    if (earlier && earlier.site === site && Date.now() - earlier.at < USERNAME_MS) {
      username = earlier.username;
    }
  }
  const r = await host.request<{ check: SaveCheck }>({
    type: 'saveCheck',
    url: page.url,
    topUrl: page.topUrl,
    username,
    password,
  });
  // Locked, paused or not connected: say nothing, as other password
  // managers do when they cannot save.
  if (!r.ok || r.value.check.state === 'saved') return { ok: true, value: null };
  const check = r.value.check;
  const offer: SaveOffer = {
    host: new URL(page.url).hostname.replace(/^www\./, ''),
    username,
    update: check.state === 'update' ? check.title : null,
  };
  const entry: Pending = {
    url: page.url,
    topUrl: page.topUrl,
    username,
    password,
    item: check.state === 'update' ? check.item : null,
    offer,
    at: Date.now(),
  };
  await chrome.storage.session.set({ [`save:${tabId}`]: entry }).catch(() => undefined);
  // A page that stays put shows the banner now; one that navigates asks
  // for it when the next page loads.
  const show: OfferSave = { type: 'offerSave', offer };
  await chrome.tabs.sendMessage(tabId, show, { frameId: 0 }).catch(() => undefined);
  return { ok: true, value: null };
}

async function save(tabId: number): Promise<Result<{ message: string }>> {
  const p = await pending(tabId);
  if (!p) return fail('badRequest', 'That login is no longer waiting to be saved.');
  const r = await host.request<{ message: string }>({
    type: 'save',
    url: p.url,
    topUrl: p.topUrl,
    username: p.username,
    password: p.password,
    item: p.item,
  });
  if (r.ok || r.code === 'denied' || r.code === 'wrongSite') await dropPending(tabId);
  return map(r, (v) => ({ message: v.message }));
}

/** Requests only the popup may make, and those only a page's content script may. */
const POPUP_ONLY = new Set<Request['type']>(['pair', 'unpair', 'tabLogins', 'tabFill', 'tabCode']);
const PAGE_ONLY = new Set<Request['type']>([
  'logins',
  'fill',
  'lastFilled',
  'typed',
  'typedUsername',
  'saveOffer',
  'save',
  'dismissSave',
]);
/** Requests only a tab's top frame may make: the save banner lives there. */
const TOP_ONLY = new Set<Request['type']>(['saveOffer', 'save', 'dismissSave']);

async function handle(msg: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts report the page's address; the popup its own.
  const fromPage = !sender.url?.startsWith(chrome.runtime.getURL(''));
  if ((fromPage && POPUP_ONLY.has(msg.type)) || (!fromPage && PAGE_ONLY.has(msg.type))) {
    return fail('badRequest', 'Not allowed from here.');
  }
  if (TOP_ONLY.has(msg.type) && sender.frameId !== 0) {
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
    case 'typed':
      if (typeof msg.username !== 'string' || typeof msg.password !== 'string' || !msg.password)
        return fail('badRequest', 'Nothing to save.');
      return typed(sender, msg.username.trim(), msg.password);
    case 'typedUsername': {
      const page = pageOf(sender);
      const tabId = sender.tab?.id;
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      if (!page || tabId === undefined || !username || username.length > 512)
        return fail('badRequest', 'Nothing to remember.');
      await chrome.storage.session
        .set({
          [`user:${tabId}`]: { username, site: new URL(page.url).origin, at: Date.now() },
        })
        .catch(() => undefined);
      return { ok: true, value: null };
    }
    case 'saveOffer': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: true, value: null };
      return { ok: true, value: (await pending(tabId))?.offer ?? null };
    }
    case 'save': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return fail('badRequest', 'Not allowed from here.');
      return save(tabId);
    }
    case 'dismissSave':
      if (sender.tab?.id !== undefined) await dropPending(sender.tab.id);
      return { ok: true, value: null };
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
  void chrome.storage.session
    .remove([`filled:${tabId}`, `save:${tabId}`, `user:${tabId}`])
    .catch(() => undefined);
});

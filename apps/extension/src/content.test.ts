// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = (req: any) => unknown;
type MsgListener = (msg: any, sender: any, respond: (r: unknown) => void) => boolean;

let reply: Reply;
let sent: any[];
let onMessage: MsgListener;
let roots: ShadowRoot[];
const added: [EventTarget, string, any, any][] = [];
const realAttach = Element.prototype.attachShadow;
const realDocAdd = document.addEventListener.bind(document);
const realWinAdd = window.addEventListener.bind(window);

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function trusted<E extends Event>(ev: E): E {
  Object.defineProperty(ev, 'isTrusted', { value: true });
  return ev;
}
const click = (el: Element, isTrusted = true) => {
  const ev = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
  el.dispatchEvent(isTrusted ? trusted(ev) : ev);
};
const focus = (el: HTMLElement) =>
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));

/** The inline menu's shadow root is the first one made, the save banner's the second. */
const menuRoot = () => roots[0]!;
const bannerRoot = () => roots[1]!;
const q = (r: ShadowRoot | undefined, sel: string) => r?.querySelector<HTMLElement>(sel) ?? null;

async function load(html: string, r: Reply = () => ({ ok: true, value: null })) {
  document.body.innerHTML = html;
  reply = (req) => r(req) ?? { ok: true, value: null };
  vi.resetModules();
  delete (window as any).__zvaultFill;
  await import('./content.js');
  await flush();
  sent.length = 0;
}

const loginForm = `
  <form id="f">
    <input id="u" type="email" name="email" />
    <input id="p" type="password" name="password" />
    <button id="go" type="submit">Log in</button>
  </form>`;
const ids = (id: string) => document.getElementById(id) as HTMLInputElement;
const login = (over = {}) => ({
  id: 'l1',
  title: 'Example Site',
  username: 'me@x.com',
  url: 'https://example.com',
  hasTotp: false,
  ...over,
});

beforeEach(() => {
  sent = [];
  roots = [];
  added.length = 0;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    const root = realAttach.call(this, { ...init, mode: 'open' });
    roots.push(root);
    return root;
  });
  // Pretend every element has a box, since happy-dom does no layout.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 210,
    bottom: 40,
    width: 200,
    height: 30,
    toJSON: () => ({}),
  });
  for (const t of [document, window] as EventTarget[]) {
    const orig = t.addEventListener.bind(t);
    vi.spyOn(t, 'addEventListener').mockImplementation((type: string, fn: any, opts?: any) => {
      added.push([t, type, fn, opts]);
      orig(type, fn, opts);
    });
  }
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'abc',
      sendMessage: vi.fn(async (req: any) => {
        sent.push(req);
        return reply(req);
      }),
      onMessage: { addListener: (l: MsgListener) => (onMessage = l) },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const [t, type, fn, opts] of added) t.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll('zvault-fill, zvault-save').forEach((e) => e.remove());
  void realDocAdd;
  void realWinAdd;
});

describe('inline menu', () => {
  it('shows a badge on a login field and lists logins when clicked', async () => {
    await load(loginForm, (r) =>
      r.type === 'logins'
        ? { ok: true, value: [login(), login({ id: 'l2', title: 'b', username: '' })] }
        : null,
    );
    expect(document.querySelector('zvault-fill')).toBeNull();
    focus(ids('u'));
    expect(document.querySelector('zvault-fill')).not.toBeNull();
    const badge = q(menuRoot(), '.badge')!;
    expect(badge.getAttribute('aria-label')).toBe('Fill with Zvault');
    expect(badge.style.left).toBe('181px');

    click(badge);
    await flush();
    const rows = menuRoot().querySelectorAll('button.row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('me@x.com');
    expect(rows[1]!.textContent).toContain('No user name');
    expect(q(menuRoot(), '.head')!.textContent).toContain('Zvault');

    click(badge);
    expect(q(menuRoot(), '.menu')).toBeNull();
  });

  it('ignores clicks that are not real ones', async () => {
    await load(loginForm);
    focus(ids('u'));
    click(q(menuRoot(), '.badge')!, false);
    await flush();
    expect(sent).toHaveLength(0);
    expect(q(menuRoot(), '.menu')).toBeNull();
  });

  it('fills the login that is picked, only on a real click', async () => {
    await load(loginForm, (r) => {
      if (r.type === 'logins') return { ok: true, value: [login()] };
      if (r.type === 'fill')
        return {
          ok: true,
          value: { username: 'me@x.com', password: 'hunter2', otp: null, otpRemaining: null },
        };
      return null;
    });
    focus(ids('u'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    const row = q(menuRoot(), 'button.row')!;
    click(row, false);
    await flush();
    expect(ids('p').value).toBe('');
    click(row);
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'fill', item: 'l1', otpOnly: false });
    expect(ids('u').value).toBe('me@x.com');
    expect(ids('p').value).toBe('hunter2');
    expect(q(menuRoot(), '.menu')).toBeNull();
  });

  it('explains empty and failed lists', async () => {
    let r: any = { ok: true, value: [] };
    await load(loginForm, (q) => (q.type === 'saveOffer' ? null : r));
    focus(ids('u'));
    const badge = q(menuRoot(), '.badge')!;
    click(badge);
    await flush();
    expect(q(menuRoot(), '.note')!.textContent).toBe('No logins saved for this website.');

    for (const [code, text] of [
      ['notPaired', 'Click the Zvault button in the toolbar and choose Connect.'],
      ['timeout', 'Nobody answered in Zvault.'],
    ] as const) {
      r = { ok: false, code, message: 'm' };
      click(badge);
      click(badge);
      await flush();
      expect(q(menuRoot(), '.note')!.textContent).toBe(text);
    }
  });

  it('offers to unlock when Zvault is locked, then retries', async () => {
    let locked = true;
    await load(loginForm, (r) => {
      if (r.type === 'unlock') {
        locked = false;
        return { ok: true, value: null };
      }
      return locked ? { ok: false, code: 'locked', message: '' } : { ok: true, value: [login()] };
    });
    focus(ids('u'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    const unlock = q(menuRoot(), 'button.action')!;
    expect(unlock.textContent).toBe('Unlock Zvault');
    click(unlock, false);
    expect(sent.some((r) => r.type === 'unlock')).toBe(false);
    click(unlock);
    await flush();
    expect(sent.some((r) => r.type === 'unlock')).toBe(true);
    expect(menuRoot().querySelectorAll('button.row')).toHaveLength(1);
  });

  it('shows a fill failure', async () => {
    await load(loginForm, (r) =>
      r.type === 'logins'
        ? { ok: true, value: [login()] }
        : { ok: false, code: 'denied', message: '' },
    );
    focus(ids('u'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    click(q(menuRoot(), 'button.row')!);
    await flush();
    expect(q(menuRoot(), '.note')!.textContent).toBe('You declined in Zvault.');
  });

  it('reports a reloaded extension when the worker is gone', async () => {
    await load(loginForm);
    (chrome.runtime.sendMessage as any).mockRejectedValue(new Error('invalidated'));
    focus(ids('u'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    expect(q(menuRoot(), '.note')!.textContent).toBe('Something went wrong.');
  });

  it('closes on Escape and on a click elsewhere, but not inside itself', async () => {
    await load(loginForm, (q) => (q.type === 'saveOffer' ? null : { ok: true, value: [login()] }));
    focus(ids('u'));
    const open = async () => {
      click(q(menuRoot(), '.badge')!);
      await flush();
    };
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(q(menuRoot(), '.menu')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(q(menuRoot(), '.menu')).toBeNull();

    await open();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(q(menuRoot(), '.menu')).toBeNull();

    await open();
    ids('u').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(q(menuRoot(), '.menu')).not.toBeNull();
    q(menuRoot(), '.menu')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, composed: true }),
    );
    // Prevented on the badge so the field keeps focus.
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    q(menuRoot(), '.badge')!.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
  });

  it('hides when focus leaves for a field that is not a login field', async () => {
    await load(`${loginForm}<input id="q" type="search" name="q" />`);
    vi.useFakeTimers();
    focus(ids('u'));
    expect(q(menuRoot(), '.badge')).not.toBeNull();
    focus(ids('q'));
    expect(q(menuRoot(), '.badge')).toBeNull();

    focus(ids('u'));
    ids('u').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    vi.advanceTimersByTime(200);
    // Still the active element? Not in happy-dom: it hides.
    expect(q(menuRoot(), '.badge')).toBeNull();
    vi.useRealTimers();
  });

  it('stays while the pointer is over the menu, and repositions on scroll and resize', async () => {
    await load(loginForm, (q) => (q.type === 'saveOffer' ? null : { ok: true, value: [login()] }));
    vi.useFakeTimers();
    focus(ids('u'));
    menuRoot().dispatchEvent(new Event('mouseover'));
    ids('u').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(q(menuRoot(), '.badge')).not.toBeNull();
    menuRoot().dispatchEvent(new Event('mouseout'));
    vi.useRealTimers();

    click(q(menuRoot(), '.badge')!);
    await flush();
    const menu = q(menuRoot(), '.menu')!;
    window.dispatchEvent(new Event('resize'));
    expect(menu.style.top).toBe('46px');
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(100);
    window.dispatchEvent(new Event('scroll'));
    expect(menu.style.bottom).toBe('96px');
  });

  it('hides when its field is not visible any more', async () => {
    await load(loginForm);
    focus(ids('u'));
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      width: 0,
      height: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('resize'));
    expect(q(menuRoot(), '.badge')).toBeNull();
  });

  it('shows the badge for a field already focused when the script loads', async () => {
    document.body.innerHTML = loginForm;
    ids('u').focus();
    vi.resetModules();
    delete (window as any).__zvaultFill;
    await import('./content.js');
    expect(document.querySelector('zvault-fill')).not.toBeNull();
  });
});

describe('one-time code fields', () => {
  const otpPage = '<form><input id="c" name="otp" autocomplete="one-time-code" /></form>';

  it('lists only logins with a code, newest used first, and fills the code', async () => {
    await load(otpPage, (r) => {
      if (r.type === 'logins')
        return {
          ok: true,
          value: [
            login({ id: 'a', title: 'A', hasTotp: true }),
            login({ id: 'b', title: 'B', hasTotp: true }),
            login({ id: 'c', title: 'C', hasTotp: false }),
          ],
        };
      if (r.type === 'lastFilled') return { ok: true, value: 'b' };
      if (r.type === 'fill')
        return { ok: true, value: { username: '', password: '', otp: '654321', otpRemaining: 20 } };
      return null;
    });
    focus(ids('c'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    const rows = Array.from(menuRoot().querySelectorAll('button.row'));
    expect(rows.map((r) => r.querySelector('.title')!.textContent)).toEqual(['B', 'A']);
    expect(rows[0]!.querySelector('.tag')!.textContent).toBe('Just used');
    expect(rows[0]!.querySelector('.sub')!.textContent).toBe('Fill the one-time code');
    click(rows[0]!);
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'fill', item: 'b', otpOnly: true });
    expect(ids('c').value).toBe('654321');
  });

  it('explains when no login has a code', async () => {
    await load(otpPage, (r) =>
      r.type === 'logins' ? { ok: true, value: [login()] } : { ok: true, value: null },
    );
    focus(ids('c'));
    click(q(menuRoot(), '.badge')!);
    await flush();
    expect(q(menuRoot(), '.note')!.textContent).toBe(
      'No login for this site has a one-time code in Zvault.',
    );
  });

  it('puts the badge after a row of one-digit boxes and fills each box', async () => {
    const boxes = Array.from(
      { length: 6 },
      (_, i) => `<input class="d" id="d${i}" maxlength="1" />`,
    ).join('');
    await load(`<form>${boxes}</form>`, (r) => {
      if (r.type === 'logins') return { ok: true, value: [login({ hasTotp: true })] };
      if (r.type === 'fill')
        return { ok: true, value: { username: '', password: '', otp: '123456', otpRemaining: 5 } };
      return { ok: true, value: null };
    });
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 40,
      bottom: 30,
      width: 40,
      height: 30,
      toJSON: () => ({}),
    });
    focus(ids('d2'));
    expect(q(menuRoot(), '.badge')!.style.left).toBe('46px');
    click(q(menuRoot(), '.badge')!);
    await flush();
    click(q(menuRoot(), 'button.row')!);
    await flush();
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>('.d'))
        .map((d) => d.value)
        .join(''),
    ).toBe('123456');
  });
});

describe('detecting a typed login', () => {
  it('reports a submitted form once, trimmed of nothing and deduplicated', async () => {
    await load(loginForm);
    ids('u').value = 'me@x.com';
    ids('p').value = 'secret';
    const form = document.getElementById('f')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const typed = sent.filter((r) => r.type === 'typed');
    expect(typed).toEqual([{ type: 'typed', username: 'me@x.com', password: 'secret' }]);
    // A changed password is a new login.
    ids('p').value = 'other';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(sent.filter((r) => r.type === 'typed')).toHaveLength(2);
  });

  it('sends a lone user name before the password page', async () => {
    await load(
      '<form id="f"><input id="u" type="email" name="email" /><button>Next</button></form>',
    );
    ids('u').value = ' me@x.com ';
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(sent).toContainEqual({ type: 'typedUsername', username: 'me@x.com' });
    sent.length = 0;
    ids('u').value = '   ';
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(sent).toHaveLength(0);
  });

  it('notices real clicks on sign-in buttons but not synthetic ones or other elements', async () => {
    await load(
      `${loginForm}<div role="button" id="rb">Sign in</div><div role="button" id="rb2">Log in</div><div role="button" id="no">Cancel</div><p id="para">x</p>`,
    );
    ids('u').value = 'a@b.c';
    ids('p').value = 'pw';
    click(document.getElementById('rb2')!, false);
    click(document.getElementById('para')!);
    click(document.getElementById('no')!);
    expect(sent).toHaveLength(0);
    click(ids('go'));
    expect(sent.at(-1)).toEqual({ type: 'typed', username: 'a@b.c', password: 'pw' });
    sent.length = 0;
    ids('p').value = 'pw2';
    click(document.getElementById('rb')!);
    expect(sent.at(-1)).toMatchObject({ password: 'pw2' });
  });

  it('notices submit inputs and Enter in a field', async () => {
    await load(
      '<input id="u" type="email" /><input id="p" type="password" /><input id="s" type="submit" value="Go" />',
    );
    ids('u').value = 'a@b.c';
    ids('p').value = 'pw';
    click(ids('s'));
    expect(sent).toHaveLength(1);
    ids('p').value = 'pw3';
    const enter = (key: string, isTrusted = true) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true });
      ids('p').dispatchEvent(isTrusted ? trusted(ev) : ev);
    };
    enter('Enter', false);
    enter('a');
    expect(sent).toHaveLength(1);
    enter('Enter');
    expect(sent).toHaveLength(2);
    expect(sent.at(-1).password).toBe('pw3');
  });

  it('ignores submits with no password typed', async () => {
    await load('<form id="f"><input name="q" type="search" /></form>');
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(sent).toHaveLength(0);
  });
});

describe('save banner', () => {
  const offer = { host: 'example.com', username: 'me@x.com', update: null };

  it('appears when a pending offer exists, and Not now dismisses it', async () => {
    await load(loginForm, (r) =>
      r.type === 'saveOffer' ? { ok: true, value: offer } : { ok: true, value: null },
    );
    expect(q(bannerRoot(), '.what')!.textContent).toBe('Save this login to Zvault?');
    expect(q(bannerRoot(), '.sub')!.textContent).toBe('me@x.com');
    expect(document.querySelector('zvault-save')).not.toBeNull();
    const later = Array.from(bannerRoot().querySelectorAll('button')).find(
      (b) => b.textContent === 'Not now',
    )!;
    click(later, false);
    expect(document.querySelector('zvault-save')).not.toBeNull();
    click(later);
    expect(sent.at(-1)).toEqual({ type: 'dismissSave' });
    expect(document.querySelector('zvault-save')).toBeNull();
  });

  it('is absent when nothing is pending', async () => {
    await load(loginForm);
    expect(document.querySelector('zvault-save')).toBeNull();
  });

  it('saves and closes itself after showing the result', async () => {
    await load(loginForm, (r) => {
      if (r.type === 'saveOffer')
        return { ok: true, value: { ...offer, update: 'Example', username: '' } };
      if (r.type === 'save') return { ok: true, value: { message: 'Saved to Zvault' } };
      return null;
    });
    expect(q(bannerRoot(), '.what')!.textContent).toContain('Update the password of');
    expect(q(bannerRoot(), '.sub')!.textContent).toBe('No user name');
    vi.useFakeTimers();
    click(q(bannerRoot(), 'button.action')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(q(bannerRoot(), '.done')!.textContent).toBe('Saved to Zvault');
    vi.advanceTimersByTime(3000);
    expect(document.querySelector('zvault-save')).toBeNull();
    vi.useRealTimers();
  });

  it('offers retry after a failure but not after a refusal', async () => {
    let code = 'timeout';
    await load(loginForm, (r) => {
      if (r.type === 'saveOffer') return { ok: true, value: offer };
      if (r.type === 'save') return { ok: false, code, message: 'm' };
      return null;
    });
    click(q(bannerRoot(), 'button.action')!);
    await flush();
    expect(q(bannerRoot(), '.note')!.textContent).toBe('Nobody answered in Zvault.');
    const labels = () =>
      Array.from(bannerRoot().querySelectorAll('button')).map((b) => b.textContent);
    expect(labels()).toEqual(['Close', 'Try again']);
    code = 'denied';
    click(q(bannerRoot(), 'button.action')!);
    await flush();
    expect(labels()).toEqual(['Close']);
    click(q(bannerRoot(), 'button.quiet')!);
    expect(document.querySelector('zvault-save')).toBeNull();
  });

  it('shows a second offer for the same site and user only once', async () => {
    await load(loginForm, (r) => (r.type === 'saveOffer' ? { ok: true, value: offer } : null));
    const first = q(bannerRoot(), '.banner')!;
    onMessage({ type: 'offerSave', offer }, { id: 'abc' }, () => {});
    expect(q(bannerRoot(), '.banner')).toBe(first);
    onMessage({ type: 'offerSave', offer: { ...offer, username: 'x' } }, { id: 'abc' }, () => {});
    expect(q(bannerRoot(), '.sub')!.textContent).toBe('x');
  });
});

describe('messages from the background worker', () => {
  const fill = { username: 'me@x.com', password: 'pw', otp: null, otpRemaining: null };
  const fillNow = (over = {}) => ({
    type: 'fillNow',
    origin: location.origin,
    fill,
    otpOnly: false,
    ...over,
  });

  it('fills the login form for the approved origin', async () => {
    await load(loginForm);
    const respond = vi.fn();
    expect(onMessage(fillNow(), { id: 'abc' }, respond)).toBe(false);
    expect(respond).toHaveBeenCalledWith(true);
    expect(ids('p').value).toBe('pw');
  });

  it('refuses a fill when the page is not on the approved origin', async () => {
    await load(loginForm);
    const respond = vi.fn();
    onMessage(fillNow({ origin: 'https://evil.example' }), { id: 'abc' }, respond);
    expect(respond).toHaveBeenCalledWith(false);
    expect(ids('p').value).toBe('');
  });

  it('refuses messages from pages, other extensions and unknown types', async () => {
    await load(loginForm);
    const respond = vi.fn();
    expect(onMessage(fillNow(), { id: 'other' }, respond)).toBe(false);
    expect(onMessage(fillNow(), { id: 'abc', tab: { id: 1 } }, respond)).toBe(false);
    expect(onMessage({ type: 'nope' }, { id: 'abc' }, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(ids('p').value).toBe('');
  });

  it('fills just the code when asked', async () => {
    await load('<input id="c" autocomplete="one-time-code" />');
    const respond = vi.fn();
    onMessage(fillNow({ otpOnly: true, fill: { ...fill, otp: '999111' } }), { id: 'abc' }, respond);
    expect(respond).toHaveBeenCalledWith(true);
    expect(ids('c').value).toBe('999111');
    onMessage(fillNow({ otpOnly: true }), { id: 'abc' }, respond);
    expect(respond).toHaveBeenLastCalledWith(false);
  });

  it('uses the focused field to pick the form to fill', async () => {
    await load(loginForm);
    ids('u').focus();
    const respond = vi.fn();
    onMessage(fillNow(), { id: 'abc' }, respond);
    expect(respond).toHaveBeenCalledWith(true);
  });
});

describe('loading', () => {
  it('runs once per page', async () => {
    await load(loginForm);
    const before = added.length;
    vi.resetModules();
    await import('./content.js');
    expect(added.length).toBe(before);
  });

  it('does nothing in a subframe except the inline menu', async () => {
    const spy = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window & typeof globalThis);
    await load(loginForm, () => ({ ok: true, value: offerFor() }));
    expect(sent.filter((r) => r.type === 'saveOffer')).toHaveLength(0);
    const respond = vi.fn();
    onMessage(
      {
        type: 'fillNow',
        origin: location.origin,
        fill: { username: 'a', password: 'b', otp: null },
        otpOnly: false,
      },
      { id: 'abc' },
      respond,
    );
    expect(respond).toHaveBeenCalledWith(false);
    onMessage(
      { type: 'offerSave', offer: { host: 'h', username: 'u', update: null } },
      { id: 'abc' },
      respond,
    );
    expect(document.querySelector('zvault-save')).toBeNull();
    spy.mockRestore();
  });
});

function offerFor() {
  return { host: 'h', username: 'u', update: null };
}

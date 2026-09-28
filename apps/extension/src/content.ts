/**
 * Runs in every page and frame. When a login or one-time code field gets
 * focus it shows a small Zvault button inside the field; clicking it lists
 * the logins Zvault has for this page and fills the one picked.
 *
 * The page cannot see or drive this UI: it lives in a closed shadow root and
 * only answers real clicks. Logins and fills come from the background worker,
 * which asks Zvault with the address the browser reports for this frame.
 */

import { fillLogin, fillOtp, isVisible, otpFields, roleOf, type Role } from './forms.js';
import {
  ERROR_TEXT,
  type Fill,
  type FillNow,
  type Login,
  type Request,
  type Result,
} from './messages.js';

declare global {
  interface Window {
    __zvaultFill?: boolean;
  }
}

const KEYHOLE =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 3.5a4.5 4.5 0 0 0-2.3 8.37L8.6 19.2a1 1 0 0 0 1 1.3h4.8a1 1 0 0 0 1-1.3l-1.1-7.33A4.5 4.5 0 0 0 12 3.5Z"/></svg>';

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.badge {
  position: fixed; width: 22px; height: 22px; border-radius: 7px; border: 0; padding: 0;
  display: grid; place-items: center; cursor: pointer; pointer-events: auto;
  background: #10204a; color: #fff; box-shadow: 0 1px 2px rgb(16 32 74 / 25%);
}
.badge:hover { background: #2f63d9; }
.menu {
  position: fixed; width: 300px; max-height: 340px; overflow: auto; pointer-events: auto;
  background: #fff; color: #10204a; border: 1px solid #e4e8f0; border-radius: 12px;
  box-shadow: 0 12px 32px -12px rgb(16 32 74 / 35%), 0 1px 3px rgb(16 32 74 / 8%);
  padding: 6px; font-size: 13px; line-height: 1.35;
}
.head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px; color: #65718c; font-size: 11.5px; }
.head b { color: #10204a; font-weight: 650; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: #10204a; color: #fff; display: grid; place-items: center; }
button.row {
  all: unset; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px;
  border-radius: 8px; cursor: pointer; box-sizing: border-box;
}
button.row:hover, button.row:focus-visible { background: #f2f5fa; }
.tile { width: 30px; height: 30px; border-radius: 8px; background: #e6eefc; color: #2f63d9; display: grid; place-items: center; font-weight: 700; font-size: 12px; flex: none; }
.main { display: grid; min-width: 0; }
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { color: #65718c; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { margin-left: auto; font-size: 11px; color: #0f8a6a; background: #e2f4ed; border-radius: 6px; padding: 2px 6px; flex: none; }
.note { padding: 8px 8px 10px; color: #65718c; }
.action { all: unset; cursor: pointer; margin: 0 8px 8px; padding: 7px 12px; border-radius: 8px; background: #2f63d9; color: #fff; font-weight: 600; display: inline-block; }
@media (prefers-color-scheme: dark) {
  .menu { background: #1a2440; color: #e9eefa; border-color: #26324f; }
  .head b { color: #e9eefa; }
  button.row:hover, button.row:focus-visible { background: #202b4a; }
  .tile { background: #1f2f5c; color: #9bb8ff; }
  .sub, .note, .head { color: #8e9ab8; }
  .tag { background: #173a33; color: #4cc79f; }
}
`;

function send<T>(req: Request): Promise<Result<T>> {
  return chrome.runtime.sendMessage<Request, Result<T>>(req).catch(() => ({
    ok: false as const,
    code: 'error' as const,
    message: 'The Zvault extension was updated; reload this page.',
  }));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; html?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.html !== undefined) e.innerHTML = props.html;
  e.append(...children);
  return e;
}

function initials(title: string): string {
  const words = title.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : title.slice(0, 2)).toUpperCase();
}

class InlineMenu {
  private readonly host = document.createElement('zvault-fill');
  private readonly root = this.host.attachShadow({ mode: 'closed' });
  private readonly badge = el('button', { class: 'badge', html: KEYHOLE });
  private menu: HTMLDivElement | null = null;
  private field: HTMLInputElement | null = null;
  private role: Role | null = null;
  private hovering = false;

  constructor() {
    this.host.style.cssText =
      'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    this.root.append(el('style', { text: STYLE }));
    this.badge.type = 'button';
    this.badge.title = 'Fill with Zvault';
    this.badge.setAttribute('aria-label', 'Fill with Zvault');
    this.badge.addEventListener('mousedown', (e) => e.preventDefault());
    this.badge.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      if (this.menu) this.closeMenu();
      else void this.openMenu();
    });
    this.root.addEventListener('mouseover', () => (this.hovering = true));
    this.root.addEventListener('mouseout', () => (this.hovering = false));

    document.addEventListener('focusin', (e) => this.onFocus(e.target), true);
    document.addEventListener(
      'focusout',
      () =>
        setTimeout(() => {
          if (!this.hovering && document.activeElement !== this.field) this.hide();
        }, 150),
      true,
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        if (e.composedPath().includes(this.host)) return;
        if (this.menu && e.target !== this.field) this.closeMenu();
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.menu) this.closeMenu();
      },
      true,
    );
    window.addEventListener('scroll', () => this.place(), true);
    window.addEventListener('resize', () => this.place());
    this.onFocus(document.activeElement);
  }

  private onFocus(target: EventTarget | null) {
    if (!(target instanceof HTMLInputElement)) return;
    const role = roleOf(target);
    if (!role) {
      if (target !== this.field) this.hide();
      return;
    }
    if (target !== this.field) this.closeMenu();
    this.field = target;
    this.role = role;
    if (!this.host.isConnected) document.documentElement.append(this.host);
    if (!this.badge.isConnected) this.root.append(this.badge);
    this.place();
  }

  private place() {
    const f = this.field;
    if (!f || !f.isConnected || !isVisible(f)) return this.hide();
    const r = f.getBoundingClientRect();
    // Inside the field's right edge, or after a row of one-digit code boxes.
    const narrow = r.width < 90;
    const edge = narrow ? (otpFieldsNear(f).at(-1) ?? f).getBoundingClientRect().right : r.right;
    const left = narrow ? edge + 6 : edge - 22 - 7;
    this.badge.style.left = `${Math.round(left)}px`;
    this.badge.style.top = `${Math.round(r.top + (r.height - 22) / 2)}px`;
    if (this.menu) {
      const below = r.bottom + 6;
      const fitsBelow = below + 200 < window.innerHeight;
      this.menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 308)))}px`;
      this.menu.style.top = fitsBelow ? `${Math.round(below)}px` : '';
      this.menu.style.bottom = fitsBelow ? '' : `${Math.round(window.innerHeight - r.top + 6)}px`;
    }
  }

  private hide() {
    this.closeMenu();
    this.badge.remove();
    this.field = null;
    this.role = null;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  private show(...children: Node[]) {
    this.closeMenu();
    const head = el(
      'div',
      { class: 'head' },
      el('span', { class: 'logo', html: KEYHOLE }),
      el('b', { text: 'Zvault' }),
      el('span', { text: location.hostname.replace(/^www\./, '') }),
    );
    this.menu = el('div', { class: 'menu' }, head, ...children);
    this.menu.setAttribute('role', 'menu');
    this.root.append(this.menu);
    this.place();
  }

  private problem(code: keyof typeof ERROR_TEXT, message?: string) {
    const note = el('div', { class: 'note', text: ERROR_TEXT[code] ?? message ?? '' });
    if (code === 'locked' || code === 'notRunning') {
      const unlock = el('button', { class: 'action', text: 'Unlock Zvault' });
      unlock.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        this.show(el('div', { class: 'note', text: 'Unlock Zvault on your Mac…' }));
        void send({ type: 'unlock' }).then(() => this.openMenu());
      });
      this.show(note, unlock);
    } else if (code === 'notPaired') {
      this.show(
        el('div', {
          class: 'note',
          text: 'Click the Zvault button in the toolbar and choose Connect.',
        }),
      );
    } else {
      this.show(note);
    }
  }

  private async openMenu() {
    const role = this.role;
    this.show(el('div', { class: 'note', text: 'Looking in Zvault…' }));
    const [list, last] = await Promise.all([
      send<Login[]>({ type: 'logins' }),
      role === 'otp' ? send<string | null>({ type: 'lastFilled' }) : Promise.resolve(null),
    ]);
    if (!this.menu) return;
    if (!list.ok) return this.problem(list.code, list.message);
    const recent = last?.ok ? last.value : null;
    let logins = role === 'otp' ? list.value.filter((l) => l.hasTotp) : list.value;
    logins = [...logins].sort((a, b) => Number(b.id === recent) - Number(a.id === recent));
    if (logins.length === 0) {
      const none =
        role === 'otp'
          ? 'No login for this site has a one-time code in Zvault.'
          : 'No logins saved for this website.';
      return this.show(el('div', { class: 'note', text: none }));
    }
    this.show(...logins.map((l) => this.row(l, role === 'otp', l.id === recent)));
  }

  private row(login: Login, otp: boolean, recent: boolean): HTMLButtonElement {
    const b = el(
      'button',
      { class: 'row' },
      el('span', { class: 'tile', text: initials(login.title) }),
      el(
        'span',
        { class: 'main' },
        el('span', { class: 'title', text: login.title }),
        el('span', {
          class: 'sub',
          text: otp ? 'Fill the one-time code' : login.username || 'No user name',
        }),
      ),
    );
    if (recent) b.append(el('span', { class: 'tag', text: 'Just used' }));
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      void this.fill(login, otp);
    });
    return b;
  }

  private async fill(login: Login, otpOnly: boolean) {
    const field = this.field;
    this.show(el('div', { class: 'note', text: `Filling ${login.title}…` }));
    const r = await send<Fill>({ type: 'fill', item: login.id, otpOnly });
    if (!r.ok) return this.problem(r.code, r.message);
    if (otpOnly) {
      if (r.value.otp) fillOtp(field ? otpFieldsNear(field) : otpFields(document), r.value.otp);
    } else {
      fillLogin(document, r.value, field);
    }
    this.hide();
  }
}

/** The code boxes that include `field`, or `field` alone. */
function otpFieldsNear(field: HTMLInputElement): HTMLInputElement[] {
  const all = otpFields(field.form ?? document);
  return all.includes(field) ? all : [field];
}

function focusedInput(): HTMLInputElement | null {
  const a = document.activeElement;
  return a instanceof HTMLInputElement ? a : null;
}

if (!window.__zvaultFill && document.documentElement instanceof HTMLHtmlElement) {
  window.__zvaultFill = true;
  new InlineMenu();

  // Fills asked for from the popup or the keyboard shortcut, in the top frame.
  chrome.runtime.onMessage.addListener((msg: FillNow, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || msg.type !== 'fillNow') return false;
    if (window !== window.top || location.origin !== msg.origin) {
      respond(false);
      return false;
    }
    const done = msg.otpOnly
      ? msg.fill.otp !== null && fillOtp(otpFields(document), msg.fill.otp)
      : fillLogin(document, msg.fill, focusedInput());
    respond(done);
    return false;
  });
}

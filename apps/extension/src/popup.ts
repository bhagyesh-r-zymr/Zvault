/**
 * The toolbar popup: connects the browser to Zvault, unlocks it, and lists
 * the logins saved for the current page with Fill and one-time code buttons.
 */

import {
  ERROR_TEXT,
  type Login,
  type PairingCode,
  type Request,
  type Result,
  type Status,
} from './messages.js';

const app = document.getElementById('app')!;
const stateLine = document.getElementById('state')!;

function send<T>(req: Request): Promise<Result<T>> {
  return chrome.runtime.sendMessage<Request, Result<T>>(req);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...children);
  return e;
}

function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, text });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function initials(title: string): string {
  const words = title.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : title.slice(0, 2)).toUpperCase();
}

function state(text: string, kind: '' | 'ready' | 'locked' = '') {
  stateLine.textContent = text;
  stateLine.className = `state ${kind}`;
}

function render(...children: Node[]) {
  app.replaceChildren(...children);
}

function empty(title: string, text: string, ...actions: Node[]) {
  render(el('div', { class: 'empty' }, el('h2', { text: title }), el('p', { text }), ...actions));
}

function problem(r: { code: keyof typeof ERROR_TEXT; message: string }) {
  return el('div', { class: 'error', text: ERROR_TEXT[r.code] ?? r.message });
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function spaced(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

async function start() {
  state('Checking…');
  const r = await send<Status & { pairingCode: string | null }>({ type: 'status' });
  if (!r.ok) {
    state('Not connected');
    if (r.code === 'notInstalled') {
      return empty(
        'Zvault for Mac is needed',
        'This extension fills logins from the Zvault app. Install it, open it once, then try again.',
      );
    }
    return render(problem(r));
  }
  const s = r.value;
  if (!s.running) {
    state('Zvault closed');
    return empty('Open Zvault', 'Zvault is not running on this Mac. Open it, then try again.');
  }
  if (!s.paired) {
    state('Not connected');
    if (s.pairingCode) return waitForPairing(s.pairingCode);
    return empty(
      'Connect this browser',
      'Zvault will ask you to approve this browser. It only ever sees a login on the website it is saved for.',
      button('Connect to Zvault', () => void pair(), 'primary'),
    );
  }
  if (s.paused) {
    state('Paused', 'locked');
    return empty('Paused in Zvault', 'Resume this browser in Zvault, under Agents.');
  }
  if (s.locked) {
    state('Locked', 'locked');
    return empty(
      'Zvault is locked',
      'Unlock Zvault on your Mac to fill logins.',
      button('Unlock Zvault', () => void unlock(), 'primary'),
    );
  }
  state('Unlocked', 'ready');
  await showLogins(s);
}

function waitForPairing(code: string) {
  empty(
    'Check the code in Zvault',
    'Zvault is asking you to connect this browser. Approve it if it shows the same code.',
    el('div', { class: 'pair-code', text: spaced(code) }),
  );
}

async function pair() {
  empty('Connecting…', 'Zvault will show a prompt on your Mac.');
  const r = await send<{ paired: boolean }>({ type: 'pair' });
  if (!r.ok) {
    await start();
    app.prepend(problem(r));
    return;
  }
  await start();
}

async function unlock() {
  empty('Unlock Zvault', 'Zvault is waiting on your Mac.');
  await send({ type: 'unlock' });
  await start();
}

async function showLogins(s: Status) {
  const tab = await activeTab();
  const footer = el(
    'footer',
    {},
    el('span', { text: s.name ?? 'Connected' }),
    button('Disconnect', () => void send({ type: 'unpair' }).then(() => start()), 'link'),
  );
  if (tab?.id === undefined) return render(footer);
  const tabId = tab.id;
  const r = await send<{ url: string; logins: Login[] }>({ type: 'tabLogins', tabId });
  if (!r.ok) {
    if (r.code === 'noForm') {
      return render(el('div', { class: 'site', text: 'Open a website to fill a login.' }), footer);
    }
    return render(problem(r), footer);
  }
  const host = new URL(r.value.url).hostname.replace(/^www\./, '');
  const site = el('div', { class: 'site' }, 'Logins for ', el('b', { text: host }));
  if (r.value.logins.length === 0) {
    return render(
      site,
      el('div', { class: 'empty' }, el('p', { text: 'No logins saved for this website.' })),
      footer,
    );
  }
  const error = el('div');
  render(site, ...r.value.logins.map((l) => loginRow(tabId, l, error)), error, footer);
}

function loginRow(tabId: number, login: Login, error: HTMLElement): HTMLElement {
  const sub = el('span', { class: 'sub', text: login.username || 'No user name' });
  const actions = el('span', { class: 'actions' });
  if (login.hasTotp) {
    actions.append(
      button('Code', () => {
        void send<{ otp: string | null; otpRemaining: number | null }>({
          type: 'tabCode',
          tabId,
          item: login.id,
        }).then(async (r) => {
          if (!r.ok) return error.replaceChildren(problem(r));
          if (!r.value.otp) return;
          await navigator.clipboard.writeText(r.value.otp).catch(() => undefined);
          sub.replaceChildren(
            'Copied ',
            el('span', { class: 'code', text: spaced(r.value.otp) }),
            r.value.otpRemaining ? ` · ${r.value.otpRemaining}s left` : '',
          );
        });
      }),
    );
  }
  actions.append(
    button(
      'Fill',
      () => {
        void send({ type: 'tabFill', tabId, item: login.id, otpOnly: false }).then((r) => {
          if (r.ok) window.close();
          else error.replaceChildren(problem(r));
        });
      },
      'primary',
    ),
  );
  return el(
    'div',
    { class: 'login' },
    el('span', { class: 'tile', text: initials(login.title) }),
    el('span', { class: 'main' }, el('span', { class: 'title', text: login.title }), sub),
    actions,
  );
}

chrome.runtime.onMessage.addListener((msg: PairingCode) => {
  if (msg.type === 'pairingCode') waitForPairing(msg.code);
});

void start();

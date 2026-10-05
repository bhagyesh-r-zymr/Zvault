// @vitest-environment happy-dom
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encKey, parseFragment, toBase64Url, type ParsedLink } from './link.js';

const ID = toBase64Url(new Uint8Array(16).fill(7));
const KEY = toBase64Url(new Uint8Array(32).fill(9));
const enc = new TextEncoder();

function seal(link: ParsedLink, payload: unknown, tamper = false) {
  const nonce = new Uint8Array(24).fill(3);
  const aad = Uint8Array.from([...enc.encode('zvault/v1/share-link:'), ...link.idBytes]);
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ct = xchacha20poly1305(encKey(link), nonce, aad).encrypt(enc.encode(text));
  if (tamper) ct[0] = ct[0]! ^ 1;
  return {
    v: 1,
    alg: 'xchacha20poly1305',
    kid: 'share-link',
    nonce: toBase64Url(nonce),
    ct: toBase64Url(ct),
  };
}

const link = parseFragment(`#${ID}.${KEY}`)!;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const opened = (payload: unknown, over: object = {}, tamper = false) =>
  json({
    blob: seal(link, payload, tamper),
    expiresAt: '2030-01-01T00:00:00.000Z',
    viewsRemaining: 2,
    ...over,
  });

type Call = { action: string; body: Record<string, unknown>; init: RequestInit; url: string };
let calls: Call[];
let routes: Record<string, () => Response | Promise<Response>>;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const app = () => document.getElementById('app')!;
const text = () => app().textContent ?? '';
const button = (label: string) =>
  Array.from(app().querySelectorAll('button')).find((b) => b.textContent === label)!;
const setHash = (hash: string) =>
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
    `https://share.test/share/${hash}`,
  );

async function open(hash = `#${ID}.${KEY}`) {
  document.body.innerHTML = '<main id="app"></main>';
  setHash(hash);
  vi.resetModules();
  await import('./main.js');
  await flush();
}

beforeEach(() => {
  calls = [];
  routes = { check: () => json({ emailRequired: false }) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const action = url.split('/').pop()!;
      calls.push({
        action,
        url,
        init,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      });
      const route = routes[action];
      if (!route) throw new Error(`unexpected ${action}`);
      return route();
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opening a link', () => {
  it('rejects an incomplete link without calling the server', async () => {
    await open('#short');
    expect(text()).toContain('This link is incomplete.');
    expect(app().querySelector('[role=alert]')).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('checks the link without counting a view, then waits for a person to reveal', async () => {
    await open();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://localhost:3000/v1/shares/links/${ID}/check`);
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    // The access token is derived, never the link key itself.
    expect(Object.keys(calls[0]!.body)).toEqual(['accessToken']);
    expect(calls[0]!.init.body).not.toContain(KEY);
    expect(button('Reveal shared item')).toBeDefined();
    expect(calls.some((c) => c.action === 'open')).toBe(false);
  });

  it.each([
    [404, 'expired, was revoked'],
    [429, 'Too many attempts'],
  ])('reports a %i from the check', async (status, message) => {
    routes.check = () => json({}, status);
    await open();
    expect(text()).toContain(message);
  });

  it('drops the key from the address bar when the link is gone', async () => {
    routes.check = () => json({}, 410);
    await open();
    expect(location.hash).toBe('');
  });

  it('says so when Zvault cannot be reached', async () => {
    routes.check = () => Promise.reject(new TypeError('offline'));
    await open();
    expect(text()).toContain('Could not reach Zvault.');
  });

  it('treats an unreadable check answer as a link without an email check', async () => {
    routes.check = () => new Response('nope');
    await open();
    expect(button('Reveal shared item')).toBeDefined();
  });
});

describe('revealing the item', () => {
  const full = {
    v: 1,
    title: 'My <b>Bank</b>',
    username: 'alice',
    password: 'p4ss',
    url: 'https://bank.example',
    notes: '<img src=x onerror=alert(1)>',
  };

  it('decrypts in the browser and renders the item as text only', async () => {
    routes.open = () => opened(full);
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(calls.at(-1)!.action).toBe('open');
    expect(calls.at(-1)!.body).toEqual({ accessToken: calls[0]!.body.accessToken });
    expect(app().querySelector('h2')!.textContent).toBe('My <b>Bank</b>');
    expect(app().querySelector('b')).toBeNull();
    expect(app().querySelector('img')).toBeNull();
    expect(app().querySelector('pre')!.textContent).toBe(full.notes);
    expect(text()).toContain('alice');
    expect(text()).toContain('https://bank.example');
    expect(text()).toContain('This link can be opened 2 more times until');
    expect(location.hash).toBe('');
  });

  it('hides the password until asked, and copies the real value', async () => {
    routes.open = () => opened(full, { viewsRemaining: 1 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).not.toContain('p4ss');
    expect(text()).toContain('1 more time until');
    expect(text()).not.toContain('1 more times');
    button('Show').click();
    expect(text()).toContain('p4ss');
    button('Hide').click();
    expect(text()).not.toContain('p4ss');

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const copy = Array.from(app().querySelectorAll('button')).filter(
      (b) => b.textContent === 'Copy',
    )[1]!;
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('p4ss');
    expect(copy.textContent).toBe('Copied');
    vi.advanceTimersByTime(1600);
    expect(copy.textContent).toBe('Copy');
  });

  it('warns on the last view', async () => {
    routes.open = () => opened({ v: 1, title: 'T' }, { viewsRemaining: 0 });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('This was the last view.');
    expect(app().querySelector('.field')).toBeNull();
  });

  it('shows a passkey with its private key hidden', async () => {
    routes.open = () =>
      opened({
        v: 1,
        title: 'Passkey',
        passkey: {
          rpId: 'example.com',
          userName: 'bob',
          userHandle: 'handle1',
          credentialId: 'cred1',
          privateKey: 'PEMDATA',
        },
      });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('A passkey for bob on example.com.');
    expect(text()).toContain('handle1');
    expect(text()).toContain('cred1');
    expect(text()).not.toContain('PEMDATA');
    button('Show').click();
    expect(text()).toContain('PEMDATA');
  });

  it('omits an empty passkey user handle', async () => {
    routes.open = () =>
      opened({
        v: 1,
        title: 'Passkey',
        passkey: {
          rpId: 'a.com',
          userName: 'u',
          userHandle: '',
          credentialId: 'c',
          privateKey: 'k',
        },
      });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).not.toContain('User handle');
  });

  it('labels a project secret', async () => {
    routes.open = () =>
      opened({
        v: 1,
        title: 'API',
        password: 'sekret',
        secret: { key: 'DB_URL', project: 'shop', environment: 'prod' },
      });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('Project secret from shop / prod');
    expect(text()).toContain('Variable');
    expect(text()).toContain('DB_URL');
    expect(text()).toContain('Value');
  });

  it('shows a live 2FA code without revealing the setup key', async () => {
    routes.open = () =>
      opened({
        v: 1,
        title: '2FA',
        totp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=6',
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await open();
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    button('Reveal shared item').click();
    await vi.advanceTimersByTimeAsync(10);
    const code = app().querySelector('.totp code')!;
    expect(code.textContent).toMatch(/^\d{3} \d{3}$/);
    expect(text()).not.toContain('GEZDGNBV');
    const ring = app().querySelector('.ring')!;
    expect(ring.textContent).toBe('30');
    vi.setSystemTime(new Date('2025-01-01T00:00:27Z'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(Number(ring.textContent)).toBeLessThanOrEqual(5);
    expect(ring.classList.contains('low')).toBe(true);
    button('Copy').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(code.textContent.replace(' ', ''));
  });

  it('ignores a 2FA setup it cannot read', async () => {
    routes.open = () => opened({ v: 1, title: 'Bad', totp: 'otpauth://totp/x?secret=!!!' });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(app().querySelector('.totp')).toBeNull();
    expect(app().querySelector('h2')!.textContent).toBe('Bad');
  });

  it.each([
    [404, 'expired, was revoked'],
    [429, 'Too many attempts'],
  ])('reports a %i from open', async (status, message) => {
    routes.open = () => json({}, status);
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain(message);
  });

  it('reports a network failure when opening', async () => {
    routes.open = () => Promise.reject(new Error('down'));
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('Could not reach Zvault.');
  });

  it('refuses a ciphertext that was altered, or whose payload is not an item', async () => {
    routes.open = () => opened({ v: 1, title: 'x' }, {}, true);
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('damaged');
    expect(text()).not.toContain('x');

    routes.open = () => opened({ v: 2, title: 'x' });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('damaged');

    routes.open = () => opened('not json');
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('damaged');
  });

  it('refuses a malformed server answer', async () => {
    routes.open = () => json({ blob: 'nope' });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('damaged');
  });

  it('cannot decrypt with a different link key', async () => {
    const other = parseFragment(`#${ID}.${toBase64Url(new Uint8Array(32).fill(1))}`)!;
    routes.open = () =>
      json({
        blob: seal(other, { v: 1, title: 'x' }),
        expiresAt: '2030-01-01T00:00:00.000Z',
        viewsRemaining: 1,
      });
    await open();
    button('Reveal shared item').click();
    await flush();
    expect(text()).toContain('damaged');
  });
});

describe('email-restricted links', () => {
  const emailLink = async () => {
    routes.check = () => json({ emailRequired: true });
    routes.code = () => json({ ok: true });
    await open();
  };
  const submitEmail = async (email = ' Me@Example.com ') => {
    const input = app().querySelector<HTMLInputElement>('input[name=email]')!;
    input.value = email;
    app()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
  };
  const submitCode = async (code = ' 123456 ') => {
    const input = app().querySelector<HTMLInputElement>('input[name=code]')!;
    input.value = code;
    app()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
  };

  it('asks for an email first and sends it normalised', async () => {
    await emailLink();
    expect(text()).toContain('shared with specific people');
    await submitEmail();
    expect(calls.at(-1)!.action).toBe('code');
    expect(calls.at(-1)!.body.email).toBe('me@example.com');
    expect(text()).toContain('we just emailed it a 6-digit code');
    expect(app().querySelector('strong')!.textContent).toBe('me@example.com');
  });

  it('ignores a blank email', async () => {
    await emailLink();
    await submitEmail('   ');
    expect(calls.filter((c) => c.action === 'code')).toHaveLength(0);
  });

  it.each([
    [429, 'Too many codes'],
    [400, 'does not look like an email'],
    [404, 'expired, was revoked'],
  ])('handles a %i when asking for a code', async (status, message) => {
    await emailLink();
    routes.code = () => json({}, status);
    await submitEmail();
    expect(text()).toContain(message);
  });

  it('handles a network failure when asking for a code', async () => {
    await emailLink();
    routes.code = () => Promise.reject(new Error('down'));
    await submitEmail();
    expect(text()).toContain('Could not reach Zvault.');
    expect(app().querySelector('input[name=email]')).not.toBeNull();
  });

  it('opens with the email and code', async () => {
    await emailLink();
    await submitEmail();
    routes.open = () => opened({ v: 1, title: 'Secret thing' });
    await submitCode();
    expect(calls.at(-1)!.action).toBe('open');
    expect(calls.at(-1)!.body).toMatchObject({ email: 'me@example.com', code: '123456' });
    expect(app().querySelector('h2')!.textContent).toBe('Secret thing');
  });

  it('shows the server message when the code is wrong, and falls back to a default', async () => {
    await emailLink();
    await submitEmail();
    routes.open = () => json({ reason: 'invalid_code', message: 'Code expired.' }, 403);
    await submitCode();
    expect(text()).toContain('Code expired.');
    // The link key stays in the address bar so the person can try again.
    expect(location.hash).not.toBe('');
    routes.open = () => new Response('x', { status: 403 });
    await submitCode();
    expect(text()).toContain('That code did not work.');
  });

  it('lets the person resend the code or change the email', async () => {
    await emailLink();
    await submitEmail();
    button('Send a new code').click();
    await flush();
    expect(calls.filter((c) => c.action === 'code')).toHaveLength(2);
    expect(text()).toContain('we just emailed it');

    routes.code = () => json({}, 429);
    button('Send a new code').click();
    await flush();
    expect(text()).toContain('Too many codes');

    routes.code = () => json({ ok: true });
    await submitEmail();
    button('Use a different email').click();
    expect(app().querySelector('input[name=email]')).not.toBeNull();
  });
});

import {
  CheckShareLinkResponse,
  OpenShareLinkResponse,
  SHARE_LIMITS,
  ShareLinkDenial,
  SharedItemPayload,
} from '@zvault/shared';
import { accessToken, openBlob, parseFragment, toBase64Url, type ParsedLink } from './link.js';
import './styles.css';

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');

// Everything below builds DOM with textContent only: the decrypted item is
// untrusted input and must never be parsed as HTML.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(...nodes: Node[]) {
  app?.replaceChildren(
    el('p', 'Zvault', { className: 'brand' }),
    el('h1', 'Shared with Zvault'),
    ...nodes,
  );
}

function errorLine(message: string) {
  return el('p', message, { className: 'error', role: 'alert' });
}

function fail(message: string) {
  render(errorLine(message));
}

const GONE = 'This link has expired, was revoked, or has already been viewed.';

function post(link: ParsedLink, action: string, body: object): Promise<Response> {
  return fetch(`${__API_ORIGIN__}/v1/shares/links/${link.id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: toBase64Url(accessToken(link)), ...body }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
}

function field(label: string, value: string, secret = false): HTMLElement {
  const row = el('div', undefined, { className: 'field' });
  const shown = el('code', secret ? '••••••••••••' : value);
  const actions = el('span', undefined, { className: 'actions' });
  if (secret) {
    const reveal = el('button', 'Show', { type: 'button' });
    reveal.addEventListener('click', () => {
      const hidden = reveal.textContent === 'Show';
      shown.textContent = hidden ? value : '••••••••••••';
      reveal.textContent = hidden ? 'Hide' : 'Show';
    });
    actions.append(reveal);
  }
  const copy = el('button', 'Copy', { type: 'button' });
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(value).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
  });
  actions.append(copy);
  row.append(el('span', label, { className: 'label' }), shown, actions);
  return row;
}

function showItem(link: ParsedLink, meta: OpenShareLinkResponse) {
  let item: SharedItemPayload;
  try {
    const plaintext = new TextDecoder().decode(openBlob(link, meta.blob));
    item = SharedItemPayload.parse(JSON.parse(plaintext));
  } catch {
    return fail('This link is damaged and could not be decrypted.');
  }
  const secret = item.secret;
  const rows = [
    secret && field('Variable', secret.key),
    item.username && field('Username', item.username),
    item.password && field(secret ? 'Value' : 'Password', item.password, true),
    item.url && field('Website', item.url),
  ].filter((r): r is HTMLElement => Boolean(r));
  const notes = item.notes ? [el('h3', 'Notes'), el('pre', item.notes)] : [];
  const passkey = item.passkey
    ? [
        el('h3', 'Passkey'),
        el(
          'p',
          `A passkey for ${item.passkey.userName} on ${item.passkey.rpId}. Import it into a passkey manager that accepts ES256 keys.`,
          { className: 'hint' },
        ),
        field('Website', item.passkey.rpId),
        field('User name', item.passkey.userName),
        field('Credential ID', item.passkey.credentialId),
        ...(item.passkey.userHandle ? [field('User handle', item.passkey.userHandle)] : []),
        field('Private key', item.passkey.privateKey, true),
      ]
    : [];
  const remaining =
    meta.viewsRemaining === 0
      ? 'This was the last view. Save what you need now; the link no longer works.'
      : `This link can be opened ${meta.viewsRemaining} more time${meta.viewsRemaining === 1 ? '' : 's'} until ${new Date(meta.expiresAt).toLocaleString()}.`;
  const from = secret
    ? [
        el('p', `Project secret from ${secret.project} / ${secret.environment}`, {
          className: 'hint',
        }),
      ]
    : [];
  render(
    el('h2', item.title),
    ...from,
    ...rows,
    ...passkey,
    ...notes,
    el('p', remaining, { className: 'hint' }),
  );
}

/**
 * Asks for the ciphertext (counting a view) and decrypts it here. For an
 * email-restricted link, `proof` is the confirmed email and its code; a
 * rejected code comes back to `onDenied` so the form can say so.
 */
async function reveal(
  link: ParsedLink,
  proof?: { email: string; code: string },
  onDenied?: (message: string) => void,
) {
  if (!proof) render(el('p', 'Decrypting on this device…'));
  let res: Response;
  try {
    res = await post(link, 'open', proof ?? {});
  } catch {
    return fail('Could not reach Zvault. Check your connection and try again.');
  }
  if (res.status === 403 && onDenied) {
    const denial = ShareLinkDenial.safeParse(await res.json().catch(() => null));
    return onDenied(denial.success ? denial.data.message : 'That code did not work.');
  }
  // The view is spent once the server answers; drop the key from the address bar.
  history.replaceState(null, '', location.pathname);
  if (res.status === 429) return fail('Too many attempts. Wait a minute and try again.');
  if (!res.ok) return fail(GONE);

  let meta: OpenShareLinkResponse;
  try {
    meta = OpenShareLinkResponse.parse(await res.json());
  } catch {
    return fail('This link is damaged and could not be decrypted.');
  }
  showItem(link, meta);
}

function askForEmail(link: ParsedLink, error?: string) {
  const form = el('form', undefined, { className: 'stack' });
  const input = el('input', undefined, {
    type: 'email',
    required: true,
    autocomplete: 'email',
    placeholder: 'you@company.com',
    name: 'email',
  });
  const submit = el('button', 'Send me a code', { type: 'submit', className: 'primary' });
  form.append(el('label', 'Your email', { htmlFor: 'email' }), input, submit);
  input.id = 'email';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    void sendCode(link, email).then((ok) => {
      if (ok) return askForCode(link, email);
      submit.disabled = false;
      submit.textContent = 'Send me a code';
    });
  });
  render(
    el('p', 'This item was shared with specific people.'),
    el('p', 'Enter your email and we will send you a one-time code to confirm it is you.', {
      className: 'hint',
    }),
    ...(error ? [errorLine(error)] : []),
    form,
  );
  input.focus();
}

/** True once the server accepted the request (it answers the same for any email). */
async function sendCode(link: ParsedLink, email: string): Promise<boolean> {
  let res: Response;
  try {
    res = await post(link, 'code', { email });
  } catch {
    askForEmail(link, 'Could not reach Zvault. Check your connection and try again.');
    return false;
  }
  if (res.status === 429) {
    askForEmail(link, 'Too many codes asked for. Wait a minute and try again.');
    return false;
  }
  if (res.status === 400) {
    askForEmail(link, 'That does not look like an email address.');
    return false;
  }
  if (!res.ok) {
    fail(GONE);
    return false;
  }
  return true;
}

function askForCode(link: ParsedLink, email: string, error?: string) {
  const form = el('form', undefined, { className: 'stack' });
  const input = el('input', undefined, {
    inputMode: 'numeric',
    autocomplete: 'one-time-code',
    pattern: `[0-9]{${SHARE_LIMITS.codeLength}}`,
    maxLength: SHARE_LIMITS.codeLength,
    required: true,
    className: 'code',
    placeholder: '000000',
    name: 'code',
  });
  input.id = 'code';
  const submit = el('button', 'Verify and reveal', { type: 'submit', className: 'primary' });
  form.append(el('label', 'One-time code', { htmlFor: 'code' }), input, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Checking…';
    void reveal(link, { email, code: input.value.trim() }, (message) =>
      askForCode(link, email, message),
    );
  });

  const resend = el('button', 'Send a new code', { type: 'button', className: 'link' });
  resend.addEventListener('click', () => {
    resend.disabled = true;
    void sendCode(link, email).then((ok) => {
      if (ok) askForCode(link, email);
    });
  });
  const change = el('button', 'Use a different email', { type: 'button', className: 'link' });
  change.addEventListener('click', () => askForEmail(link));
  const more = el('p', undefined, { className: 'row' });
  more.append(resend, change);

  const sent = el('p');
  sent.append(
    'If ',
    el('strong', email),
    ` can open this item, we just emailed it a ${SHARE_LIMITS.codeLength}-digit code. It works once and expires in ${SHARE_LIMITS.codeTtlMinutes} minutes.`,
  );
  render(sent, ...(error ? [errorLine(error)] : []), form, more);
  input.focus();
}

function askToReveal(link: ParsedLink) {
  // Opening counts a view, so wait for a person to ask. Link previewers and
  // mail scanners that merely load the page will not use it up.
  const button = el('button', 'Reveal shared item', { type: 'button', className: 'primary' });
  button.addEventListener('click', () => void reveal(link), { once: true });
  render(
    el(
      'p',
      'Someone shared an item with you. It is decrypted in this browser; Zvault never sees it.',
    ),
    el('p', 'Revealing it may use up the link.', { className: 'hint' }),
    button,
  );
}

async function start(link: ParsedLink) {
  render(el('p', 'Checking the link…', { className: 'hint' }));
  let res: Response;
  try {
    // Counts no view, so it is safe to ask as soon as the page loads.
    res = await post(link, 'check', {});
  } catch {
    return fail('Could not reach Zvault. Check your connection and try again.');
  }
  if (res.status === 429) return fail('Too many attempts. Wait a minute and try again.');
  if (!res.ok) {
    history.replaceState(null, '', location.pathname);
    return fail(GONE);
  }
  const check = CheckShareLinkResponse.safeParse(await res.json().catch(() => null));
  if (check.success && check.data.emailRequired) askForEmail(link);
  else askToReveal(link);
}

const link = parseFragment(location.hash);
if (!link) fail('This link is incomplete. Ask the sender for the full link.');
else void start(link);

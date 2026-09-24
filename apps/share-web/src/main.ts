import { OpenShareLinkResponse, SharedItemPayload } from '@zvault/shared';
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
  app?.replaceChildren(el('h1', 'Shared with Zvault'), ...nodes);
}

function fail(message: string) {
  render(el('p', message, { className: 'error', role: 'alert' }));
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

async function reveal(link: ParsedLink) {
  render(el('p', 'Decrypting on this device…'));
  let res: Response;
  try {
    res = await fetch(`${__API_ORIGIN__}/v1/shares/links/${link.id}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: toBase64Url(accessToken(link)) }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch {
    return fail('Could not reach Zvault. Check your connection and try again.');
  }
  // The view is spent once the server answers; drop the key from the address bar.
  history.replaceState(null, '', location.pathname);
  if (res.status === 429) return fail('Too many attempts. Wait a minute and try again.');
  if (!res.ok) return fail('This link has expired, was revoked, or has already been viewed.');

  let item: SharedItemPayload;
  let meta: OpenShareLinkResponse;
  try {
    meta = OpenShareLinkResponse.parse(await res.json());
    const plaintext = new TextDecoder().decode(openBlob(link, meta.blob));
    item = SharedItemPayload.parse(JSON.parse(plaintext));
  } catch {
    return fail('This link is damaged and could not be decrypted.');
  }

  const rows = [
    item.username && field('Username', item.username),
    item.password && field('Password', item.password, true),
    item.url && field('Website', item.url),
  ].filter((r): r is HTMLElement => Boolean(r));
  const notes = item.notes ? [el('h3', 'Notes'), el('pre', item.notes)] : [];
  const remaining =
    meta.viewsRemaining === 0
      ? 'This was the last view. Save what you need now; the link no longer works.'
      : `This link can be opened ${meta.viewsRemaining} more time${meta.viewsRemaining === 1 ? '' : 's'} until ${new Date(meta.expiresAt).toLocaleString()}.`;
  render(el('h2', item.title), ...rows, ...notes, el('p', remaining, { className: 'hint' }));
}

const link = parseFragment(location.hash);
if (!link) {
  fail('This link is incomplete. Ask the sender for the full link.');
} else {
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

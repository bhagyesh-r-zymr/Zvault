import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';

// Mirrors apps/share-web/src/link.ts: a share link is #<id>.<key>, the item is
// sealed under an HKDF-derived key with the link id as associated data.
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export const API = 'http://localhost:3000';

export interface Item {
  v: 1;
  title: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
}

export function makeLink(item: Item) {
  const id = randomBytes(16);
  const key = randomBytes(32);
  const aad = Uint8Array.from([...enc.encode('zvault/v1/share-link:'), ...id]);
  const encKey = hkdf(sha256, key, id, enc.encode('zvault/v1/share-link/enc'), 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(encKey, nonce, aad).encrypt(enc.encode(JSON.stringify(item)));
  return {
    id: b64u(id),
    fragment: `#${b64u(id)}.${b64u(key)}`,
    blob: { v: 1, alg: 'xchacha20poly1305', kid: 'share-link', nonce: b64u(nonce), ct: b64u(ct) },
  };
}

/** Stands in for the API: the page only ever talks to /v1/shares/links/:id/*. */
export async function mockShareApi(
  page: Page,
  handlers: Partial<Record<'check' | 'open' | 'code', { status: number; body?: unknown }>>,
) {
  const calls: { action: string; body: unknown }[] = [];
  await page.route(`${API}/v1/shares/links/*/*`, async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop() as string;
    calls.push({ action, body: route.request().postDataJSON() });
    const h = handlers[action as 'check'];
    await route.fulfill({
      status: h?.status ?? 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(h?.body ?? {}),
    });
  });
  // The page POSTs JSON, so the browser sends a preflight first.
  await page.route(`${API}/**`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type',
            'access-control-allow-methods': 'POST',
          },
        })
      : route.fallback(),
  );
  return calls;
}

import type { SharedItemPayload } from '@zvault/shared';
import { useMemo, useState } from 'react';
import { sharingApi } from './api.js';
import { ShareItem } from './ShareItem.js';
import { SharingCenter } from './SharingCenter.js';

/**
 * Sharing screen. Until vault items exist, a scratch item stands in for the
 * item being shared; the item view will render `ShareItem` directly.
 */
export function SharingPanel() {
  const api = useMemo(() => sharingApi(), []);
  const [item, setItem] = useState<SharedItemPayload>({ v: 1, title: '' });
  const set =
    (k: 'title' | 'username' | 'password' | 'url' | 'notes') =>
    (e: { target: { value: string } }) =>
      setItem({ ...item, [k]: e.target.value });

  return (
    <>
      <section>
        <h2>Share an item</h2>
        <label>
          Title <input value={item.title} onChange={set('title')} />
        </label>
        <label>
          Username <input value={item.username ?? ''} onChange={set('username')} />
        </label>
        <label>
          Password <input type="password" value={item.password ?? ''} onChange={set('password')} />
        </label>
        <label>
          Website <input value={item.url ?? ''} onChange={set('url')} />
        </label>
        {item.title && <ShareItem item={item} api={api} />}
      </section>
      <SharingCenter api={api} />
    </>
  );
}

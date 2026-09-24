import type { DeviceInfo } from '@zvault/shared';
import { describe, expect, it } from 'vitest';
import {
  hashToken,
  InMemorySessionStore,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from './session.store.js';

const mac: DeviceInfo = { name: 'Work MacBook', platform: 'macos', appVersion: '0.1.0' };
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);
const DAY = 24 * 60 * 60 * 1000;

describe('InMemorySessionStore', () => {
  it('keeps only a hash of the token', async () => {
    const store = new InMemorySessionStore();
    const { session, token } = await store.issue('u1', mac);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('authenticates a live token and rejects unknown ones', async () => {
    const store = new InMemorySessionStore();
    const { session, token } = await store.issue('u1', mac);
    expect((await store.authenticate(token))?.id).toBe(session.id);
    expect(await store.authenticate('x'.repeat(43))).toBeNull();
  });

  it('expires sessions after the idle timeout', async () => {
    const store = new InMemorySessionStore();
    const { token } = await store.issue('u1', mac, at(0));
    expect(await store.authenticate(token, at(SESSION_IDLE_TTL_MS - 1))).not.toBeNull();
    // That use refreshed lastSeenAt, so the idle window restarts from there.
    expect(await store.authenticate(token, at(2 * SESSION_IDLE_TTL_MS - 2))).not.toBeNull();
    expect(await store.authenticate(token, at(3 * SESSION_IDLE_TTL_MS))).toBeNull();
  });

  it('expires sessions after the absolute lifetime even if active', async () => {
    const store = new InMemorySessionStore();
    const { token } = await store.issue('u1', mac, at(0));
    for (let t = 0; t < SESSION_ABSOLUTE_TTL_MS; t += DAY) {
      expect(await store.authenticate(token, at(t))).not.toBeNull();
    }
    expect(await store.authenticate(token, at(SESSION_ABSOLUTE_TTL_MS))).toBeNull();
  });

  it('lists only the given user’s live sessions', async () => {
    const store = new InMemorySessionStore();
    await store.issue('u1', mac, at(0));
    const fresh = await store.issue('u1', mac, at(SESSION_IDLE_TTL_MS));
    await store.issue('u2', mac, at(SESSION_IDLE_TTL_MS));
    const listed = await store.listForUser('u1', at(SESSION_IDLE_TTL_MS + 1));
    expect(listed.map((s) => s.id)).toEqual([fresh.session.id]);
  });

  it('will not revoke another user’s session', async () => {
    const store = new InMemorySessionStore();
    const theirs = await store.issue('u2', mac);
    expect(await store.revoke('u1', theirs.session.id)).toBe(false);
    expect(await store.authenticate(theirs.token)).not.toBeNull();
  });

  it('revokes all but the kept session for one user only', async () => {
    const store = new InMemorySessionStore();
    const keep = await store.issue('u1', mac);
    const other = await store.issue('u1', mac);
    const stranger = await store.issue('u2', mac);
    expect(await store.revokeAllExcept('u1', keep.session.id)).toBe(1);
    expect(await store.authenticate(keep.token)).not.toBeNull();
    expect(await store.authenticate(other.token)).toBeNull();
    expect(await store.authenticate(stranger.token)).not.toBeNull();
  });
});

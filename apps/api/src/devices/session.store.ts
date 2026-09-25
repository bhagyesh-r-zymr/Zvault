import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DeviceInfo } from '@zvault/shared';

/** A server-side session. The bearer token itself is never stored, only its hash. */
export interface Session {
  id: string;
  userId: string;
  device: DeviceInfo;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface IssuedSession {
  session: Session;
  /** Returned to the client once at sign-in; only its hash is kept. */
  token: string;
}

/** Sessions end after this long regardless of activity. */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Sessions unused for this long are treated as signed out. */
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Skip lastSeenAt writes that would change it by less than this. */
export const TOUCH_GRANULARITY_MS = 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Storage for signed-in sessions. Sign-in creates them with `issue`; the
 * devices endpoints list and revoke them. Persistence backends implement
 * this same contract.
 */
export abstract class SessionStore {
  abstract issue(userId: string, device: DeviceInfo, now?: Date): Promise<IssuedSession>;
  /** Returns the live session for a bearer token, or null if unknown, revoked or expired. */
  abstract authenticate(token: string, now?: Date): Promise<Session | null>;
  abstract listForUser(userId: string, now?: Date): Promise<Session[]>;
  /** Revokes one of the user's sessions. Returns false if the user has no such session. */
  abstract revoke(userId: string, sessionId: string): Promise<boolean>;
  /** Revokes every session of the user except `keepSessionId`. Returns how many were revoked. */
  abstract revokeAllExcept(userId: string, keepSessionId: string): Promise<number>;
}

function isLive(s: Session, now: Date): boolean {
  const t = now.getTime();
  return t < s.expiresAt.getTime() && t - s.lastSeenAt.getTime() < SESSION_IDLE_TTL_MS;
}

/** Process-local store for development and tests. */
@Injectable()
export class InMemorySessionStore extends SessionStore {
  private readonly byId = new Map<string, Session>();
  private readonly idByTokenHash = new Map<string, string>();

  issue(userId: string, device: DeviceInfo, now = new Date()): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const session: Session = {
      id: randomUUID(),
      userId,
      device,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
    };
    this.byId.set(session.id, session);
    this.idByTokenHash.set(session.tokenHash, session.id);
    return Promise.resolve({ session: { ...session }, token });
  }

  authenticate(token: string, now = new Date()): Promise<Session | null> {
    const id = this.idByTokenHash.get(hashToken(token));
    const session = id === undefined ? undefined : this.byId.get(id);
    if (!session) return Promise.resolve(null);
    if (!isLive(session, now)) {
      this.delete(session);
      return Promise.resolve(null);
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_GRANULARITY_MS) {
      session.lastSeenAt = now;
    }
    return Promise.resolve({ ...session });
  }

  listForUser(userId: string, now = new Date()): Promise<Session[]> {
    const sessions: Session[] = [];
    for (const s of [...this.byId.values()]) {
      if (s.userId !== userId) continue;
      if (isLive(s, now)) sessions.push({ ...s });
      else this.delete(s);
    }
    return Promise.resolve(sessions);
  }

  revoke(userId: string, sessionId: string): Promise<boolean> {
    const session = this.byId.get(sessionId);
    if (!session || session.userId !== userId) return Promise.resolve(false);
    this.delete(session);
    return Promise.resolve(true);
  }

  revokeAllExcept(userId: string, keepSessionId: string): Promise<number> {
    let revoked = 0;
    for (const s of [...this.byId.values()]) {
      if (s.userId === userId && s.id !== keepSessionId) {
        this.delete(s);
        revoked++;
      }
    }
    return Promise.resolve(revoked);
  }

  private delete(session: Session): void {
    this.byId.delete(session.id);
    this.idByTokenHash.delete(session.tokenHash);
  }
}

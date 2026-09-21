import { randomUUID } from 'node:crypto';
import { PtySession } from './pty.js';
import type { SessionId, SessionOptions } from './types.js';

/**
 * Owns the set of live sessions.
 *
 * Ids are server-generated UUIDs, never caller-supplied: a session handle is
 * meant to be an unforgeable key, not a name another caller can guess or
 * collide with.
 */
export class SessionRegistry {
  private readonly sessions = new Map<SessionId, PtySession>();

  create(options: SessionOptions = {}): PtySession {
    const id = randomUUID();
    const session = new PtySession(id, options);
    this.sessions.set(id, session);
    return session;
  }

  get(id: SessionId): PtySession | undefined {
    return this.sessions.get(id);
  }

  /** Ids of every session the registry tracks, live or exited. */
  list(): SessionId[] {
    return [...this.sessions.keys()];
  }

  /**
   * Kill and remove a session. History is not owned by the registry, so
   * dropping the live session does not discard anything already recorded.
   */
  remove(id: SessionId): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    session.dispose();
    this.sessions.delete(id);
    return true;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Kill and dispose everything. */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.remove(id);
    }
  }
}

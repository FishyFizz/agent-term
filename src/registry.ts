import { randomUUID } from 'node:crypto';
import { TerminalSession } from './session.js';
import type { SessionId, SessionOptions } from './types.js';

/**
 * Owns the set of live sessions.
 *
 * Ids are server-generated UUIDs, never caller-supplied: a session handle is
 * meant to be an unforgeable key, not a name another caller can guess or
 * collide with.
 *
 * It holds `TerminalSession`s rather than bare ptys. A registry of ptys was
 * the L0.5 substrate's own view, but everything above L0.5 needs the
 * classified session, so every caller was reassembling one by hand -- and
 * `TerminalSession` was not reachable from the registry at all.
 */
export class SessionRegistry {
  private readonly sessions = new Map<SessionId, TerminalSession>();

  create(options: SessionOptions = {}): TerminalSession {
    const id = randomUUID();
    const session = new TerminalSession(id, options);
    this.sessions.set(id, session);
    return session;
  }

  get(id: SessionId): TerminalSession | undefined {
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

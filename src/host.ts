/**
 * The composition root: live sessions and their timelines, wired once.
 *
 * Two objects that must agree, and one place that makes them. `registry.ts`
 * explains that history is *not* owned by the registry -- dropping a live
 * session must not discard what it did -- but somebody still has to start
 * recording, and a history that is merely available to attach is a history a
 * caller can forget to attach. It would then be empty rather than wrong, which
 * surfaces much later and looks like a bug in the timeline.
 *
 * So the registry stays history-agnostic, exactly as its comment says, and this
 * is where the two are joined: `open` creates and starts recording in one call,
 * and `close` ends the session while leaving the record readable.
 */
import { SessionRegistry } from './registry.js';
import { HistoryStore, type SessionHistory } from './history.js';
import type { SessionUpdate, TerminalSession } from './session.js';
import type { SessionId, SessionOptions } from './types.js';

/** A session and the timeline recording it. */
export interface OpenSession {
  session: TerminalSession;
  history: SessionHistory;
}

export class SessionHost {
  readonly registry = new SessionRegistry();
  readonly history = new HistoryStore();

  /**
   * The last classified update each live session produced.
   *
   * Owned here rather than by a surface, because it is a fact about the
   * session and not about whoever is asking. A surface that kept its own copy
   * would answer `(no output yet)` to the second caller — which a stateless
   * transport makes every request.
   */
  private readonly latestUpdate = new Map<SessionId, SessionUpdate>();

  /**
   * Start a session and begin recording it.
   *
   * One call, because two would be one call too many: a caller that spawned a
   * session and forgot the second step would get a working terminal whose
   * history was silently empty.
   */
  open(options: SessionOptions = {}): OpenSession {
    const session = this.registry.create(options);
    const history = this.history.open(session);
    session.onUpdate((update) => this.latestUpdate.set(session.id, update));
    return { session, history };
  }

  session(id: SessionId): TerminalSession | undefined {
    return this.registry.get(id);
  }

  /**
   * The last update a session produced, or `undefined` if none has yet.
   *
   * `undefined` is not an empty screen: a session that has produced no output
   * has no update, and saying so is different from describing a blank one.
   */
  lastUpdate(id: SessionId): SessionUpdate | undefined {
    return this.latestUpdate.get(id);
  }

  /** The timeline for a session, live or finished. */
  historyFor(id: SessionId): SessionHistory | undefined {
    return this.history.get(id);
  }

  /**
   * Kill and remove a live session.
   *
   * Its history is deliberately untouched: history has to survive the
   * process exiting and stay queryable after the fact, so ending a session is
   * the moment the record matters most, not the moment to drop it.
   */
  close(id: SessionId): boolean {
    return this.registry.remove(id);
  }

  /** Kill every live session. Histories remain readable. */
  disposeAll(): void {
    this.registry.disposeAll();
  }
}

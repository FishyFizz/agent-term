/**
 * A view of one live session: what a human watching it is shown.
 *
 * The agent drives a session it cannot see. This is the seam that lets a human
 * see the same screen and type into the same pty -- the human half of the
 * interaction, which is otherwise entirely one-sided. It is **L3**: the
 * architecture files a viewer under "outer implementation" and its boundary
 * test says rewriting the human viewer must not force an inner layer to change,
 * so nothing below this knows views exist.
 *
 * ## It carries the screen, never bytes
 *
 * The one rule this obeys is the project's own: **one parser, one truth**
 * (`docs/design.md`). `ScreenModel` is the authority for what a human at the
 * terminal would see, and everything above it reads cells. A viewer that
 * mirrored the program's raw output into a second terminal would be putting a
 * second VT parser into the system, free to disagree with the first about what
 * is on the screen -- disagreeing in exactly the case that matters, since the
 * two would only differ once the output got interesting. So the wire carries
 * `ScreenSnapshot`, which is already a plain JSON structure built for crossing
 * a boundary, and both clients render it.
 *
 * The corollary is a refusal worth naming: **xterm.js is not used**, though it
 * is the obvious thing to reach for in a browser. It is a VT parser; it would
 * have to be fed bytes, and there are no bytes to feed it.
 *
 * Input is the other direction and is not subject to the rule: a keystroke
 * going *into* the pty was never something the parser had an opinion about.
 *
 * ## Granularity is the delivery, not the group
 *
 * Updates come from `onDelivery`, not `onUpdate`. A group is the unit the
 * *agent* is shown -- it collapses the frames a repaint produced into one act,
 * because an agent paying for context should not pay for each frame. A human
 * watching the same repaint wants the frames. Both come off the same stream;
 * only the projection differs.
 *
 * ## What it refuses to say
 *
 * The facts a caller gets are "how many clients are attached", "when a human
 * last typed", and "how many bytes that was". **Not what was typed.** What a
 * human writes is visible to the agent to the extent the program echoes it and
 * no further: a password typed at a prompt with echo off stays between the
 * human and the program, which is the only place either of them would expect
 * it to be. The agent is told that intervention happened and when, which is all
 * it needs in order to stop assuming it is the only writer.
 *
 * `attached` is a real count, so `0` is an honest "nobody is connected".
 * `lastInputAt` and `lastInputBytes` are `null` before any human input --
 * "no human has typed" and "we cannot say" are different facts, and the repo
 * does not conflate them.
 */
import { composeSteps, KeyInputError, type Composed, type Step } from './keys.js';
import { realClock, type GroupClock } from './groups.js';
import type { ScreenSnapshot } from './screen.js';
import type { KeyModes } from './keys.js';
import type { TerminalSession } from './session.js';
import type { PtyExitInfo } from './pty.js';

/**
 * How a view paces what it hands out.
 *
 * Policy, so it is injected rather than written as a constant: the number is a
 * judgement about how fast a human can read, which is a deployment's to make
 * and a test's to replace. There is no bound on *how much* is coalesced, only
 * on how often it goes out -- a burst that lasts a minute still sends a frame
 * every interval, and coalescing always ends on the newest screen, never on a
 * stale one that happened to be pending.
 */
export interface ViewPolicy {
  /** Most screen events per second. Default 30. */
  maxFps?: number;
  /** The clock and timer the pacing uses. Injected so a test needs no sleeping. */
  clock?: GroupClock;
}

/** The default pacing. Faster than a human reads, slower than a repaint floods. */
export const DEFAULT_VIEW_POLICY: Required<ViewPolicy> = {
  maxFps: 30,
  clock: realClock,
};

/** What a viewer is told. */
export type ViewEvent =
  /** The screen changed. `seq` is the delivery it now stands at. */
  | { type: 'screen'; seq: number; screen: ScreenSnapshot; modes: KeyModes }
  /**
   * Nothing more will arrive: the process is gone, or the session ended.
   *
   * `exit` is the pty's own fact and is `null` when the session was disposed
   * without the process reporting one -- a session that was killed rather than
   * one that exited.
   */
  | { type: 'ended'; exit: PtyExitInfo | null };

/**
 * What is observable about the human, and nothing more.
 *
 * Deliberately not a part of `SessionState`: that stays the closed set of facts
 * about a session, and "a human is watching" is a fact about *this*, the outer
 * layer that put them there.
 */
export interface ViewFacts {
  /** Clients currently attached. A real count; `0` means nobody is connected. */
  attached: number;
  /** When a human last sent input, in the session's millisecond space. `null` before any. */
  lastInputAt: number | null;
  /** Bytes in that input. `null` before any. */
  lastInputBytes: number | null;
}

/**
 * One session's view.
 *
 * Transport-free on purpose: it owns what a viewer is *shown* and what a human
 * *sent*, and nothing about how either travels. `view-server.ts` puts a
 * loopback socket in front of it; a test talks to it directly; a different
 * transport can replace that without this file learning anything.
 */
export class SessionView {
  readonly sessionId: string;

  private readonly session: TerminalSession;
  private readonly clock: GroupClock;
  private readonly intervalMs: number;

  private readonly listeners: ((event: ViewEvent) => void)[] = [];
  private attachedCount = 0;

  /** The newest screen not yet handed out. Coalescing keeps exactly one. */
  private pending: ViewEvent | null = null;
  private timer: unknown = null;
  private lastFlushAt = 0;

  private _lastInputAt: number | null = null;
  private _lastInputBytes: number | null = null;
  private _closed = false;
  private readonly offs: (() => void)[] = [];

  constructor(session: TerminalSession, policy: ViewPolicy = {}) {
    this.session = session;
    this.sessionId = session.id;
    this.clock = policy.clock ?? DEFAULT_VIEW_POLICY.clock;
    const maxFps = policy.maxFps ?? DEFAULT_VIEW_POLICY.maxFps;
    this.intervalMs = Math.max(1, Math.floor(1000 / Math.max(1, maxFps)));

    // Raw deliveries, not updates: see the header.
    this.offs.push(
      this.session.onDelivery((delivery) => {
        this.push({
          type: 'screen',
          seq: delivery.seq,
          screen: delivery.screen,
          modes: this.modes,
        });
      }),
    );
    // A resize changes the shape of the grid, which a viewer has to know about
    // whether or not the program has drawn anything at the new size yet. The
    // notification is queued behind deliveries, so this lands in order.
    this.offs.push(
      this.session.onResize(() => {
        this.push({
          type: 'screen',
          seq: this.session.seq,
          screen: this.snapshot(),
          modes: this.modes,
        });
      }),
    );
    // The process exiting is the ordinary end of a view: nothing more will
    // arrive. The notification is queued behind the feed, so the last of the
    // output is delivered before this fires -- a viewer told `ended` has
    // already been shown the last thing the program drew.
    this.offs.push(this.session.onExit((info) => this.end(info)));
    // The safety net that lets `close_session` end a view without the registry
    // knowing views exist: whatever kills the session, the view ends with it.
    // Killed rather than exited, so there is no exit fact to report.
    this.offs.push(this.session.onDispose(() => this.end(null)));
  }

  /** The screen as it is now. What a client is sent on attaching. */
  snapshot(): ScreenSnapshot {
    return this.session.screen.snapshot();
  }

  /**
   * The modes the program has set, read off the emulator.
   *
   * Sent with every screen so the terminal client can mirror them into its own
   * terminal. That is what makes the bytes a human's keyboard produces correct
   * for the program: an arrow is a different sequence under application cursor
   * keys, and the mode that decides is the *session's*, not the client's.
   */
  get modes(): KeyModes {
    return this.session.screen.modes;
  }

  /** The state this view is at, in the numbering `seq` reports. */
  get seq(): number {
    return this.session.seq;
  }

  /** The grid the session is at now. */
  get size(): { cols: number; rows: number } {
    return { cols: this.session.screen.cols, rows: this.session.screen.rows };
  }

  /**
   * Attach a client. Returns the detach, which is idempotent.
   *
   * One call rather than a `subscribe` plus a counter: two would be two things
   * to forget, and a client that unsubscribed without decrementing would leave
   * `attached` claiming a human is watching when the socket is gone.
   */
  attach(listener: (event: ViewEvent) => void): () => void {
    this.listeners.push(listener);
    this.attachedCount++;
    let off = false;
    return () => {
      if (off) return;
      off = true;
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
      this.attachedCount--;
    };
  }

  /**
   * Send what a human typed, as named steps.
   *
   * Composed through `composeSteps` against the mode the program has set --
   * the same call `send_sequence` makes -- so a key a human presses is encoded
   * for the program that is going to read it and not for a fixed table. A step
   * that will not compose is the caller's mistake and comes back as
   * `KeyInputError` for the transport to turn into a typed error; it is not
   * swallowed here, and it is not an exception this raises on its own account.
   */
  send(steps: readonly Step[]): Composed {
    const composed = composeSteps(steps, this.modes);
    this.write(composed.bytes);
    return composed;
  }

  /**
   * Send raw bytes a human's own terminal produced.
   *
   * The terminal client forwards rather than decodes: turning an escape
   * sequence back into a key name is lossy guesswork, where the bytes are
   * exactly what the keyboard sent. Their correctness rests on the mode
   * mirroring `modes` enables, not on anything here.
   */
  sendRaw(bytes: string): number {
    if (bytes === '') {
      // An empty write still moves the input watermark, so it would be
      // reported as input that was not input.
      throw new KeyInputError('a raw write is not empty');
    }
    return this.write(bytes);
  }

  /**
   * Resize the session to a client's window.
   *
   * `TerminalSession.resize` does the whole job -- pty, emulator, the group in
   * flight, the epoch everything before it is frozen at -- so the human's
   * window and the agent's grid are one grid, which is the point.
   */
  resize(cols: number, rows: number): void {
    this.session.resize(cols, rows);
  }

  get facts(): ViewFacts {
    return {
      attached: this.attachedCount,
      lastInputAt: this._lastInputAt,
      lastInputBytes: this._lastInputBytes,
    };
  }

  /** Whether this view will produce anything more. */
  get closed(): boolean {
    return this._closed;
  }

  /** Detach from the session and stop listening. Idempotent. */
  close(): void {
    this.end();
  }

  /** Bytes actually written. `0` when the process is gone and nothing went in. */
  private write(bytes: string): number {
    // Nothing goes into a dead pty -- `PtySession.write` is a no-op there --
    // so recording it as input would report a fact that did not happen.
    if (!this.session.pty.alive) return 0;
    this.session.send(bytes);
    this._lastInputAt = this.clock.now();
    this._lastInputBytes = Buffer.byteLength(bytes, 'utf8');
    return this._lastInputBytes;
  }

  /** Queue one event, paced. The newest always wins; nothing is dropped but the stale. */
  private push(event: ViewEvent): void {
    if (this._closed) return;
    this.pending = event;
    if (this.timer !== null) return;

    const wait = Math.max(0, this.lastFlushAt + this.intervalMs - this.clock.now());
    if (wait === 0) {
      this.flush();
      return;
    }
    this.timer = this.clock.set(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const event = this.pending;
    this.pending = null;
    if (!event) return;
    this.lastFlushAt = this.clock.now();
    for (const listener of [...this.listeners]) listener(event);
  }

  /**
   * End the view: hand out whatever is pending, then say nothing more is
   * coming, then go quiet.
   *
   * The pending event goes out first. A session that produced a screen and
   * then exited did produce that screen, and a viewer told only "ended" would
   * never see the last thing the program drew.
   */
  private end(exit?: PtyExitInfo | null): void {
    if (this._closed) return;
    this._closed = true;
    if (this.timer !== null) {
      this.clock.clear(this.timer);
      this.timer = null;
    }
    this.flush();
    const reported = exit === undefined ? this.session.state().exit : exit;
    for (const listener of [...this.listeners]) listener({ type: 'ended', exit: reported });
    // Ending the view detaches whoever was on it: a count that kept them would
    // go on reporting a human watching a session nothing is watching. The
    // transport unsubscribes too, and idempotently -- this is the count's own
    // half of the same fact.
    this.attachedCount = Math.max(0, this.attachedCount - this.listeners.length);
    this.listeners.length = 0;
    for (const off of this.offs.splice(0)) off();
  }
}

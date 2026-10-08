/**
 * A hosted terminal session: pty + screen model + classifier, as one object.
 *
 * This is a durable, independent session: the classifier and screen model
 * attached. It owns the pty, feeds every byte to the emulator, and reports
 * each change as ordered segments of `writing` or `drawing`.
 *
 * What it deliberately does not do: deliver, coalesce on a timer, or store
 * history. Those sit above this.
 *
 * Output is classified as it arrives: the pty's `data` is wired straight to
 * `feed` in the constructor. Otherwise a caller could build a session, never
 * subscribe, and have a classifier that silently never runs -- a mistake
 * possible by omission, which is the kind worth removing.
 */
import { PtySession, type PtyExitInfo } from './pty.js';
import { ScreenModel } from './screen.js';
import { classify, frameOf } from './classify.js';
import type { Segment } from './classify.js';
import { applyDelta, gridDelta, type GridDelta } from './delta.js';
import { matchLine, matchRow, type MatchSurface, type OutputMatch } from './match.js';
import type { TextLine } from './text-log.js';
import type { ScreenSnapshot } from './screen.js';
import type { SessionOptions } from './types.js';
import { assertGridSize } from './types.js';
import { GroupDetector, DEFAULT_GROUP_POLICY, realClock, type GroupClock, type GroupCloseReason, type Group } from './groups.js';

/** One classified change to a session. */
export interface SessionUpdate {
  sessionId: string;
  /**
   * Sequence number, per session, from 1 — **the number of the state this
   * update ends at**, not a count of updates.
   *
   * It is the raw stream counter (`Delivery.seq`), incremented once per raw
   * delivery, which is the same number the timeline records with
   * (`history.ts`). One number therefore addresses: what the agent was just
   * shown, and any intermediate state inside it — the frames a group swallowed
   * are simply the numbers between `collapsed.rawFrom` and `rawTo`, readable
   * with `history_read({from:{seq:a}, to:{seq:b}})`.
   *
   * A group is a projection over a run of these and occupies no number of its
   * own, so the sequence never skips: state N is always the Nth thing the
   * session produced, whether or not it was shown as part of a group.
   */
  seq: number;
  /**
   * Which group this update was shown as, or the same as `seq` when output is not
   * being grouped.
   *
   * The group's number is what `history.groups()` reports and what the agent was
   * shown; `seq` above is the raw state this update ends at. They differ
   * whenever a group swallowed more than one delivery — which is exactly the
   * case where the extra states are addressable between `collapsed.rawFrom`
   * and `rawTo` but were never shown as their own update.
   */
  group: number;
  at: number;
  /** Byte range of the pty output this update covers. */
  fromByte: number;
  toByte: number;
  segments: Segment[];
  /**
   * Rows of this update's screen that differ from the state before it.
   *
   * The row-level half of `segments`, and the one that answers "did my input
   * change the UI?" for a keystroke that wrote no line: a highlight moving is
   * one or two rows here and a byte span covering a whole region there. Empty
   * when nothing on the grid changed, which with a non-empty `segments` means
   * a repaint that landed on no row at all -- a cursor move, or a write into
   * cells that already held those glyphs.
   *
   * Indices only. The content is in `screen`, and `history_read` has the frame
   * they replaced; shipping both sides here would cost a second screen per
   * update for a fact the caller can already reach.
   */
  changedRows: number[];
  io: SessionIo;
  /**
   * Completed lines produced by this delivery, in order.
   *
   * The screen grid alone is not a record of what was written: it holds the
   * viewport, so lines that scrolled out are in no snapshot. These are those
   * lines, and they are the only record of alt-screen content, which is
   * destroyed on exit.
   */
  text: TextLine[];
  /**
   * What this delivery changed on the grid, or `null` when nothing changed or
   * a delta would not have been smaller than the screen itself.
   *
   * Storing the delta rather than only the screen is what keeps a repainting
   * TUI affordable: 60fps of full grids is ~17 MB/minute at 120x40, where the
   * change is usually a few cells. The screen is still reported whole, because
   * a caller that wants the state should not have to reconstruct it.
   */
  grid: GridDelta | null;
  /** The screen after this update. Present whenever the change touched it. */
  screen: ScreenSnapshot;
  /**
   * What was merged into this update, or `null` when nothing was.
   *
   * `null` is the honest value when the session is not grouping output into
   * groups, or when this update came from a direct `feed`: an
   * unknown is `null`, never a fabricated `1`.
   *
   * `chunks > 1` is the signal a consumer acts on: the screen it is looking at
   * is the net effect of that many raw deliveries, so *intermediate states
   * existed and were not shown*. A selector whose highlight moved and moved
   * back is the case that matters — it nets to no visible change at all, and
   * the count is the only evidence anything happened.
   */
  collapsed: CollapsedInfo | null;
}

/**
 * What one delivered group swallowed.
 *
 * Same meaning whatever the granularity: a group is one update, and this says
 * how much raw output it stands for, so a consumer can decide to go back and
 * read the intermediates rather than being told about them.
 */
export interface CollapsedInfo {
  /** Raw pty deliveries merged into this update. */
  chunks: number;
  /**
   * Whether states existed that this update does not show.
   *
   * Redundant with `chunks > 1`, and deliberately so: it is the one field a
   * consumer has to act on without reading documentation. When it is true the
   * screen being shown is a net effect, and states between it and the previous
   * update were seen and then collapsed away.
   */
  intermediates: boolean;
  /** Ops recorded across the merged span. */
  ops: number;
  /** Bytes merged. Equal to `toByte - fromByte`; kept so it need not be derived. */
  bytes: number;
  /** Why the group stopped accumulating — which is why the granularity changed. */
  reason: GroupCloseReason;
  /** Milliseconds between the first and last delivery in the group. */
  spanMs: number;
  /**
   * The deliveries this group stands for, as an inclusive range of `Delivery.seq`.
   * Pass to `SessionHistory.span(from, to)` to read and play them back.
   *
   * `0..0` when grouping is off: nothing was swallowed, so there is nothing to
   * play back and the honest answer is an empty range rather than `1..1`.
   */
  rawFrom: number;
  rawTo: number;
}

/**
 * One raw delivery — the canonical unit of what a session produced.
 *
 * Emitted for every delivery, grouped or not, and recorded by the timeline.
 * A group is a *projection* over a run of these (`history.groups`), which is why
 * nothing here carries a verdict: the presentation classifies the span from
 * the frames, and a verdict stored beside those frames would be a second
 * opinion that could drift from them.
 *
 * The screen is always supplied. Whether it is *kept* as a keyframe or encoded
 * as a delta against the previous delivery is the timeline's decision, not the
 * session's — encoding is what a store does.
 */
export interface Delivery {
  /** Monotonic per session, independent of the group sequence. */
  seq: number;
  /** The group this delivery was grouped into. */
  group: number;
  at: number;
  fromByte: number;
  toByte: number;
  /** Completed lines this delivery produced. */
  text: TextLine[];
  /** Rows the emulator reported the content moved. */
  scrolledRows: number;
  /** What changed on the grid, or `null` when a delta would not be smaller. */
  grid: GridDelta | null;
  /** The screen after this delivery. */
  screen: ScreenSnapshot;
}

/**
 * The facts that distinguish "quiet" from "not read yet".
 *
 * `bytesRead` is a watermark: monotonic, never reset, so comparing an earlier
 * value against the current one says whether anything arrived since.
 *
 * `bytesPending` is bytes the pty handed us that the parser has not finished
 * with. `null` when the number is not knowable, and 0 only when it is genuinely
 * zero: unknown values are `null`, never `0`, because conflating
 * the two is a whole class of interaction bug.
 *
 * It is `null` rather than `0` when the parser has also been handed bytes that
 * did not come from this pty — a caller feeding buffers directly. The two
 * counters are then not a difference of the same thing, and reporting a clamped
 * zero would answer a question that was never asked with a number that looks
 * like an answer to it.
 */
export interface SessionIo {
  /** Total bytes read from the pty. Monotonic. */
  bytesRead: number;
  /** Bytes read but not yet parsed. `null` when not knowable. */
  bytesPending: number | null;
  /**
   * Bytes written into the pty that no output has followed. `null` before any
   * input; `0` when output has been produced since the last write.
   *
   * **A byte count, not a verdict about the program.** It is the most a byte
   * interface can honestly say about "is it still waiting": input went in and
   * nothing has come back out. Whether the program is blocked on a prompt,
   * busy computing, or has not flushed is **not observable here** — measured
   * on this machine, a shell running a slow builtin and a shell sitting at a
   * prompt are indistinguishable from outside (identical process state, no
   * child process either way).
   *
   * `null` before any input because "nothing written" and "we cannot say" are
   * different facts.
   */
  inputUnconsumed: number | null;
}

/**
 * What a session is doing, stated as facts.
 *
 * Three readings fall out of it, and they are the whole surface:
 *
 *   running, idle for x ms
 *   exit, more to read
 *   exit, drained
 *
 * There is deliberately no "settled". Whether a live program will produce more
 * output is not provable at a byte interface: it may emit at any future moment
 * for reasons entirely internal to it -- a timer, a network reply, a
 * background group -- and the only event that closes the set is termination. A
 * state claiming otherwise would be a judgement dressed as an observation.
 * `idleMs` is the measurement; what it means is the caller's call, and the
 * caller is the one that knows what it is driving.
 *
 * `exit` is the pty's own fact, not the session's queued `onExit`
 * notification. The queued one fires only after the feed has drained, so a
 * state built on it could never report "exit, more to read" -- the state would
 * be unreachable, and the window it exists to describe would be invisible.
 */
export interface SessionState {
  /** Whether the pty has reported the process gone. */
  running: boolean;
  /** Milliseconds since the pty last handed us a byte. `null` before the first. */
  idleMs: number | null;
  /**
   * Whether everything the pty handed us has been through the parser.
   *
   * `false` after an exit is the window worth waiting in: the last of the
   * output is still in the pipeline, and a read taken there is missing its
   * tail with nothing left to correct it.
   *
   * `null` when it cannot be known — see `pendingBytes`.
   */
  drained: boolean | null;
  /** Bytes the pty handed us that the parser has not finished with. */
  bytesPending: number | null;
  /**
   * Bytes written into the pty that no output has followed. `null` before any
   * input; `0` once output has come back.
   *
   * The input watermark. It is the most a byte interface can say about
   * "is it still waiting" and it says nothing about *why*: a shell running a
   * slow builtin and a shell at a prompt cannot be told apart from outside,
   * which is why there is no `atPrompt` here.
   */
  inputUnconsumed: number | null;
  /** Exit info once the pty has reported the process gone, otherwise `null`. */
  exit: PtyExitInfo | null;
}

/**
 * Why a wait ended.
 *
 * `idle` and `timeout` are the difference the caller is judging: one says the
 * quiet period was observed, the other says it was not and time ran out.
 */
export type WaitReason =
  /**
   * Quiet for at least the interval asked for, and caught up.
   *
   * It does not mean the program has finished. Nothing observable can say
   * that, and a caller that reads `idle` as "done" is making a judgement this
   * value deliberately does not make.
   */
  | 'idle'
  /**
   * The process is gone and everything it wrote has been parsed.
   *
   * Waiting longer cannot change what is observable, so the wait ends early
   * rather than sitting out a quiet period that no longer means anything.
   */
  | 'exited'
  /** Gave up. `state` says what was seen; the caller decides what to do. */
  | 'timeout';

/** The result of a bounded wait. */
export interface WaitResult {
  reason: WaitReason;
  /**
   * The state the wait ended at, in the numbering every `seq` reports.
   *
   * Carried although this wait returns no screen, because it is the number that
   * makes the moment addressable: `history_read({from:{seq}})` reads on from
   * where the wait stopped. It is always present -- the timeout branch names it
   * too, rather than letting the shared loop's bare fallback omit it and leave
   * a declared field silently missing.
   */
  seq: number;
  /** What was observed when the wait ended. */
  state: SessionState;
  /** Milliseconds the wait lasted, on the session's clock. */
  waitedMs: number;
}

/** What `waitForIdle` is asked for. Both bounds are required. */
export interface WaitOptions {
  /** How long the pty must have been quiet, in milliseconds. */
  idleMs: number;
  /** Stop waiting after this long, in milliseconds. */
  timeoutMs: number;
}

/** What `waitForGroup` is asked for. */
export interface WaitForGroupOptions {
  /**
   * Only a group ending at a state *after* this one counts.
   *
   * The same numbering `seq` reports: a state in the timeline, not a count of
   * updates (see `SessionUpdate.seq`). Defaults to the last state the session
   * was typed at, so a group that closed before the input was sent cannot
   * satisfy the wait.
   */
  sinceSeq?: number;
  /**
   * Stop waiting after this long, in milliseconds.
   *
   * The only bound that always holds. A policy without caps never closes a
   * firehose group, so the caps cannot be relied on to end this on their own.
   */
  timeoutMs: number;
}

/**
 * Why a group wait ended.
 *
 * `group` carries the reason the group closed in `collapsed.reason`, and the four
 * do not mean the same thing: `bytes`/`chunks` are caps cutting a group open
 * while the program is still writing, `flush` is a resize or an exit forcing
 * it, and only `gap` means the program went quiet on its own.
 */
export type GroupWaitReason = 'group' | 'disposed' | 'exited' | 'timeout';

export interface GroupWaitResult {
  reason: GroupWaitReason;
  /**
   * Whether this group contains output produced **after** the last input was
   * sent. `null` before any input.
   *
   * This is the causal half of the input watermark -- a fact, not a verdict:
   * the group's byte span either starts after the input watermark or it does
   * not. It does **not** say the program was waiting, or that it finished, or
   * that this output is a *response* — only where the bytes sit relative to
   * the write.
   *
   * `false` is the case worth acting on: the wait ended on output that was
   * already in flight before the input, so sending more input would be
   * typing into something that has not read the last thing yet.
   */
  afterInput: boolean | null;
  /**
   * The state the wait reached, and the number the returned screen is at.
   *
   * Always present, and never a guess. On a group it is the last state the
   * group covered, so a caller that wants the frames it swallowed reads
   * `history_read({from:{seq:collapsed.rawFrom}, to:{seq}})`. On the three
   * reasons where no group arrived it is the **current** state -- the one the
   * `screen` beside it shows -- and not `sinceSeq`, so the screen it comes with
   * is addressable by the number in the same response. `sinceSeq` stays for the
   * baseline; the two differ whenever output arrived that no group closed on.
   */
  seq: number;
  /** Which group, or `null` when no group arrived. */
  group: number | null;
  /** What the group merged, or `null`. `chunks > 1` means states were swallowed. */
  collapsed: CollapsedInfo | null;
  /**
   * The completed lines this group produced, or `null` when no group arrived.
   *
   * The same lines a read reports for the same state, carried here so a wait
   * and a read of one state agree instead of describing it twice.
   */
  text: TextLine[] | null;
  /**
   * What the group wrote and drew, or `null` when no group arrived.
   *
   * The same verdict the classifier reached for a read, and it is on the wait
   * because that verdict -- appended text against a redrawn surface -- is what
   * a caller driving a full-screen program needs and cannot recover from the
   * screen alone. **`text` empty beside a non-empty `segments` is a group that
   * repainted without writing a line**: a cursor moving, a highlight following
   * it, a menu drawn over itself. That is a different fact from "output
   * stopped", and the screen looks the same either way.
   */
  segments: Segment[] | null;
  /**
   * Rows of the screen this group changed, or `null` when no group arrived.
   *
   * `segments` says a redraw happened and over which bytes; this says which
   * rows it landed on. It is the answer to "did my key do anything" when the
   * act wrote no line: a highlight moving is one or two rows, where the byte
   * span covers a whole region and a screen-to-screen comparison covers
   * nothing. Empty beside a non-empty `segments` means the act touched no row.
   */
  changedRows: number[] | null;
  /** The byte watermark this group reached, or `null` when no group arrived. */
  io: SessionIo | null;
  /** The screen as it was when the wait ended, or `null` on `disposed`. */
  screen: ScreenSnapshot | null;
  /** What was observed when the wait ended. */
  state: SessionState;
  /** Milliseconds the wait lasted, on the session's clock. */
  waitedMs: number;
  /** The baseline used, so the caller can see what "new" meant. */
  sinceSeq: number;
}

/** What `waitForOutput` is asked for. */
export interface WaitForOutputOptions {
  /**
   * The pattern to look for, already compiled.
   *
   * Compiled by the caller because a pattern that will not compile is the
   * caller's mistake, not a fact about the session, and the surface turns it
   * into a typed error before a wait exists.
   */
  pattern: RegExp;
  /** Which sinks to match: screen rows, completed lines, or both. Default `both`. */
  surface?: MatchSurface;
  /**
   * Match only content produced *after* this byte watermark.
   *
   * Defaults to `pty.lastInputByte` — the byte the session was last typed into.
   * A wait for output is nearly always a wait for a *reaction*, and a reaction
   * is by construction produced after the input that caused it; without a
   * baseline the prompt already on screen would match the instant the wait
   * began, which is the bug this parameter exists to prevent.
   */
  sinceByte?: number;
  /** Stop waiting after this long, in milliseconds. */
  timeoutMs: number;
}

/**
 * Why a pattern wait ended.
 *
 * `matched` is a positive observation and needs no quiet period to mean
 * anything, which is why there is no `idle` here: a match is visible the moment
 * it is on screen. It is still not a verdict -- the tty echoes what is typed,
 * so an echo is a match on new output like any other, and whether what matched
 * was the program answering is the caller's call.
 */
export type OutputWaitReason = 'matched' | 'exited' | 'timeout';

/** The result of a wait for a pattern. */
export interface OutputWaitResult {
  reason: OutputWaitReason;
  /** Where the pattern was seen, or `null` when it was not. */
  match: OutputMatch | null;
  /**
   * The state the wait reached, and the number the returned screen is at.
   *
   * The same numbering `SessionUpdate.seq` and `history_read` use, so a caller
   * that timed out can address the screen it was handed -- `screen` is the
   * current grid, and this is the number that state is filed under. It labels
   * the *state*, not the match: on a match it is where the wait ended when the
   * pattern appeared, which may be later than the row the pattern is on.
   */
  seq: number;
  /**
   * The screen as it was when the wait ended, or `null` on a match.
   *
   * Present exactly when `match` is not: on `timeout` and `exited` there is
   * nothing else to show, and a caller that has to decide what to do next
   * would otherwise read again to find out -- the round trip this field
   * removes. On `matched` the match *is* the answer, and a screen would be a
   * second, larger one.
   *
   * `null` rather than absent by design: a field that is sometimes missing is
   * silently read as "nothing", which is the `bytesPending: null` vs `0` class
   * of bug.
   */
  screen: ScreenSnapshot | null;
  /** What was observed when the wait ended. */
  state: SessionState;
  /** Milliseconds the wait lasted, on the session's clock. */
  waitedMs: number;
  /** The baseline used, so the caller can see what "new" meant. */
  sinceByte: number;
}

/** A grid size a session was resized to. */
export interface SessionSize {
  cols: number;
  rows: number;
}

/** Add `listener` to `list`, and return the function that takes it back out. */
function subscribe<T>(list: T[], listener: T): () => void {
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * A terminal session that classifies its own output.
 *
 * Feeding is serialized: the emulator's write is async and `snapshot()` is
 * only meaningful after it resolves, so overlapping feeds would interleave
 * frames and corrupt both the diff and the byte offsets.
 */
export class TerminalSession {
  readonly id: string;
  readonly pty: PtySession;
  readonly screen: ScreenModel;
  private readonly clock: GroupClock;

  private readonly listeners: ((update: SessionUpdate) => void)[] = [];
  private readonly resizeListeners: ((size: SessionSize) => void)[] = [];
  private readonly exitListeners: ((info: PtyExitInfo) => void)[] = [];
  private readonly disposeListeners: (() => void)[] = [];
  /** Present unless the session was opened with `groupPolicy: false`. */
  private readonly groups?: GroupDetector;
  private readonly deliveryListeners: ((delivery: Delivery) => void)[] = [];
  /**
   * Per row, the byte watermark of the delivery that last wrote it.
   *
   * What lets a wait tell a row that *appeared* from one that merely *moved*,
   * which is the difference between a prompt the program just printed and a
   * prompt that scrolled up and is still sitting there. Rows a delivery's
   * `GridDelta` wrote are stamped; rows that only shifted are not, because a
   * shift is reported as `scrollBy` and the runs describe the content that
   * genuinely changed. O(rows) to keep -- forty numbers at 120x40.
   */
  private rowWrittenAt: number[];
  /**
   * When the last byte arrived from the pty, or `null` before the first.
   *
   * Set on the pty's `data`, not on delivery: see `idleMs` for why the
   * difference is the whole point.
   */
  private _lastByteAt: number | null = null;
  /**
   * Waiters for the session changing, woken by `wake`.
   *
   * A waiter is woken rather than polling: the alternatives are a timer on a
   * fixed step, which is a sleep by another name, and a caller inventing its
   * own, which is what waiting on an observation exists to stop.
   */
  private readonly waiters: (() => void)[] = [];
  private _seq = 0;
  private _rawSeq = 0;
  /** The state the session was last typed at. See `send`. */
  private _lastInputSeq = 0;
  /**
   * The last update this session delivered, or `null` before the first.
   *
   * Kept so a wait can catch up on an act that already happened. Between a send
   * and a wait there is a round trip, and for an agent that round trip is not
   * milliseconds: a program can finish an act inside it, and a waiter that only
   * listens for the *next* one would sleep to its deadline while the answer sat
   * in this field. `waitForOutput` reads the current screen to catch up; a
   * group is not a screen, so the group itself has to be kept.
   */
  private _lastUpdate: SessionUpdate | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendings = 0;
  /**
   * Bytes the parser has finished with. Monotonic.
   *
   * Not `screen.ops.bytesFed`, which is counted *before* the write because op
   * handlers run during it and their offsets must already include the bytes
   * that produced them. That makes it a count of bytes handed over, so a chunk
   * mid-parse reads as done — the opposite of what "pending" asks.
   */
  private _bytesParsed = 0;

  constructor(id: string, options: SessionOptions = {}) {
    this.id = id;
    this.clock = options.clock ?? realClock;
    this.pty = new PtySession(id, options);
    this.screen = new ScreenModel(this.pty.cols, this.pty.rows);
    this.rowWrittenAt = new Array<number>(this.screen.rows).fill(0);

    // Grouping is the default: where a delivery begins decides what the
    // classifier can see, and the alternative is letting
    // the pty's buffer decide it. `false` is the opt-out.
    const policy = options.groupPolicy === false ? undefined : (options.groupPolicy ?? DEFAULT_GROUP_POLICY);
    if (policy) {
      // Grouped at the boundary the program drew rather than the one the pty's
      // buffer happened to fill: `groups.ts` has the reasoning.
      this.groups = new GroupDetector(
        policy,
        (group) => {
          void this.feed(group.bytes, group).then(this.deliver);
        },
        this.clock,
      );
    }

    this.pty.on('data', (chunk) => {
      // Stamped here, at the byte, before anything decides what to do with it.
      this._lastByteAt = this.clock.now();
      this.wake();
      if (this.groups) {
        this.groups.push(chunk);
        return;
      }
      void this.feed(chunk).then(this.deliver);
    });
    // The state input was typed at, stamped where the bytes go in. Taken from
    // the pty's event rather than written into `send`, because `pty.write` is
    // not a private path: a test or a script writes through it directly, and a
    // baseline only `send` maintained was left at 0 for those -- which the
    // group wait's catch-up then read as "nothing has been typed", offering the
    // group that closed *before* the input. That is the same forgetting the
    // pty's own byte watermark avoids by stamping at the write (`pty.ts`), and
    // `waitForGroup` defaults its baseline to this exactly as `waitForOutput`
    // defaults to that one.
    this.pty.on('input', () => {
      this._lastInputSeq = this._rawSeq;
    });
    // Queued, not fired directly: the last bytes of a session are delivered
    // before it exits, and a caller told "it exited" while an update is still
    // in the queue would have to guess whether to wait.
    this.pty.on('exit', (info) => {
      // Flushed first, for the same reason as a resize and more urgently:
      // alt-screen content is destroyed when the program leaves it, so
      // the last live frame has to be classified before the exit is reported.
      this.groups?.flush();
      this.wake();
      this.enqueue(() => {
        for (const listener of this.exitListeners) listener(info);
      });
    });
  }

  /**
   * Subscribe to classified output. Returns an unsubscribe function.
   *
   * Every change produces an update, in the order the pty produced it.
   */
  onUpdate(listener: (update: SessionUpdate) => void): () => void {
    return subscribe(this.listeners, listener);
  }

  /**
   * Subscribe to resizes. Returns an unsubscribe function.
   *
   * Fires *after* any delivery already in flight, so a listener that records
   * position in the update stream never has to decide whether a boundary came
   * before or after the update it is looking at.
   */
  onResize(listener: (size: SessionSize) => void): () => void {
    return subscribe(this.resizeListeners, listener);
  }

  /** Subscribe to the process exiting. Returns an unsubscribe function. */
  onExit(listener: (info: PtyExitInfo) => void): () => void {
    return subscribe(this.exitListeners, listener);
  }

  /**
   * Subscribe to the session ending. Returns an unsubscribe function.
   *
   * `dispose()` clears the other listener lists before it wakes anyone, so a
   * waiter subscribed to those would be silently unsubscribed and would only
   * return when its own deadline ran out -- which looks like a timeout. This
   * exists so a wait can report that the session is gone instead.
   */
  onDispose(listener: () => void): () => void {
    return subscribe(this.disposeListeners, listener);
  }

  /**
   * Send input. The state it was typed at is stamped by the pty's `input`
   * event, which fires for every write and not only for this one -- see the
   * subscription in the constructor.
   */
  send(input: string): void {
    this.pty.write(input);
  }

  /**
   * Whether this session groups output into groups.
   *
   * `wait_for_group` has nothing to wait for without one, and it says so rather
   * than hanging: a session opened with `groupPolicy: false` produces no group
   * boundary at all, so the wait would always run to its deadline.
   */
  get grouping(): boolean {
    return this.groups !== undefined;
  }

  /** The state input was last typed at, whoever wrote it. */
  get lastInputSeq(): number {
    return this._lastInputSeq;
  }

  /** Hand one update to every listener, and keep it for a wait to catch up on. */
  private readonly deliver = (update: SessionUpdate): void => {
    this._lastUpdate = update;
    for (const listener of this.listeners) listener(update);
  };

  /**
   * Every delivery this session produces, in order. Returns an unsubscribe.
   *
   * This is the stream: the raw record from which a group is projected, and what
   * a timeline stores. Emitted whether or not output is being grouped — the
   * grouping decides what the *agent* is shown, not what happened.
   */
  onDelivery(listener: (delivery: Delivery) => void): () => void {
    return subscribe(this.deliveryListeners, listener);
  }

  /**
   * Run `task` after everything already queued.
   *
   * Same shape as `feed`'s keep-alive: the chain is reassigned to a promise
   * that cannot reject, so one throwing listener cannot strand the deliveries
   * behind it.
   */
  private enqueue(task: () => void): void {
    const run = this.queue.then(() => {
      task();
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
  }

  /**
   * Feed one chunk of pty output and classify it. Serialized.
   *
   * `group` may carry the group this chunk belongs to, in which case the update
   * reports what was merged. A caller feeding bytes directly gets
   * `collapsed: null`, which is correct: nothing was merged, and claiming `1`
   * would say otherwise.
   */
  feed(chunk: Buffer, group?: Group): Promise<SessionUpdate> {
    this.pendings++;
    const run = this.queue.then(async () => {
      const fromByte = this.screen.ops.bytesFed;
      // A group is classified over its whole span -- that is what makes a
      // repaint legible -- but it is *fed* one raw delivery at a time, because
      // the intermediate frames are the only place the swallowed states exist
      // and they cannot be recovered from merged bytes afterwards.
      const parts = group ? group.parts : [chunk];
      const groupStartSnap = this.screen.snapshot();
      const groupStart = frameOf(this.screen, groupStartSnap);

      let rawFrom = 0;
      let rawTo = 0;
      let scrolled = 0;
      let ops = 0;
      const text: TextLine[] = [];
      let afterSnap = groupStartSnap;
      let after = groupStart;

      // The number this update is filed under, named once. `_seq` counts
      // updates and is incremented once, after the deliveries below are
      // emitted, so it is still the previous update at both places that need
      // this number; the delivery stamps and the update stamp have to agree on
      // which group they are describing, and this is the one copy they share.
      const groupNumber = this._seq + 1;

      for (const part of parts) {
        // One witness, and it belongs to the model: `feed` takes the frames,
        // counts the ops and the scroll, judges the text, and hands all of it
        // back. The caller used to take its own before/after pair around this
        // call, which was a second witness to the same bytes.
        const partFromByte = this.screen.ops.bytesFed;
        const facts = await this.screen.feed(part);
        // Counted after the write resolves, unlike `bytesFed` — see the field.
        this._bytesParsed += part.length;
        // Dropped here, so a long session's op stream does not accumulate.
        this.screen.ops.clear();
        const beforeSnap = facts.before;
        afterSnap = facts.after;
        after = frameOf(this.screen, afterSnap);
        ops += facts.ops.length;
        scrolled += facts.scrolledRows;
        text.push(...facts.text);

        // Emitted for every delivery, grouped or not: this is the stream, and
        // the group is a projection over it. The hint is the emulator's own
        // scroll count, not the viewport difference -- `viewportY` saturates
        // once the scrollback ring is full and reports 0 while content keeps
        // moving.
        const seq = ++this._rawSeq;
        const toByte = this.screen.ops.bytesFed;
        // Stored as the delta rather than only as the screen, and read here as
        // well: the runs are what say which rows this delivery *wrote*, as
        // opposed to which ones a scroll moved (`noteWritten`).
        const grid = gridDelta(beforeSnap, afterSnap, facts.scrolledRows);
        this.noteWritten(grid, toByte);
        const delivery: Delivery = {
          seq,
          group: group ? groupNumber : seq,
          at: Date.now(),
          fromByte: partFromByte,
          toByte,
          text: facts.text,
          scrolledRows: facts.scrolledRows,
          grid,
          screen: afterSnap,
        };
        for (const listener of this.deliveryListeners) listener(delivery);
        if (group) {
          if (rawFrom === 0) rawFrom = seq;
          rawTo = seq;
        }
      }

      this._seq++;
      // The state this update ends at: the last raw delivery it covered, or --
      // when there was no group to cover them -- the head of the stream. Named
      // once because it is `seq` and, ungrouped, the group number too.
      //
      // The numbering is the raw delivery's, which is the numbering the
      // timeline and `history_read` address: a group that swallowed 1..7
      // reports 7, and everything between stays addressable. The previous
      // counter counted *updates*, which skipped the frames a group collapsed
      // -- the one number an agent holds was not one it could address history
      // with.
      const endsAt = rawTo === 0 ? this._rawSeq : rawTo;
      const classified = classify({
        before: groupStart,
        after,
        fromByte,
        toByte: this.screen.ops.bytesFed,
        scrolledBy: scrolled,
      });

      return {
        sessionId: this.id,
        seq: endsAt,
        // The group this update was shown as: the same number the deliveries it
        // merged were stamped with (`delivery.group`). Ungrouped, each delivery
        // is its own group and the two numbers coincide.
        group: group ? groupNumber : endsAt,
        at: Date.now(),
        fromByte,
        toByte: classified.toByte,
        segments: classified.segments,
        changedRows: classified.changedRows,
        text,
        // The viewport delta is exactly the scroll until the scrollback ring
        // saturates; past that it is useless, and the encoder falls back to
        // searching for a shift it can verify (see `delta.ts`).
        grid: gridDelta(groupStartSnap, afterSnap, after.viewportY - groupStart.viewportY),
        // Not zero by construction. Everything this update covers is already
        // parsed, so what is left is what arrived *behind* it: bytes that came
        // in while it was being written, still held by the group detector or
        // queued behind this feed. That is the honest number here -- a
        // hardcoded 0 would make "nothing pending" unfalsifiable.
        io: {
          bytesRead: this.pty.bytesRead,
          bytesPending: this.pendingBytes(),
          inputUnconsumed: this.pty.unconsumedBytes,
        },
        screen: afterSnap,
        collapsed: group
          ? {
              chunks: group.chunks,
              intermediates: group.chunks > 1,
              ops,
              bytes: classified.toByte - fromByte,
              reason: group.reason,
              spanMs: group.closedAt - group.startedAt,
              rawFrom,
              rawTo,
            }
          : null,
      } satisfies SessionUpdate;
    });

    // Keep the chain alive regardless of one feed failing.
    this.queue = run.then(
      () => {
        this.pendings--;
        this.wake();
      },
      () => {
        this.pendings--;
        this.wake();
      },
    );
    return run;
  }

  /** Feeds queued but not yet processed. */
  get pending(): number {
    return this.pendings;
  }

  /**
   * Milliseconds since the pty last handed us a byte. `null` before the first.
   *
   * Measured from the *byte*, not from the last delivery. A program that never
   * pauses never opens a gap, so a group stays open until a cap closes it and no
   * delivery completes for seconds at a time — idle measured from the last
   * delivery would report "idle for 2560ms" while the program was flooding
   * output, which is the one thing this number must never do.
   *
   * It is a measurement and nothing else. It does not say the program has
   * finished; nothing observable can, and a caller deciding whether to act is
   * making a judgement this number deliberately does not make for it.
   */
  idleMs(at: number = this.clock.now()): number | null {
    if (this._lastByteAt === null) return null;
    return at - this._lastByteAt;
  }

  /**
   * What the session is doing, as facts. `at` is injectable so a caller can
   * ask about a moment it already has, rather than one this call invents.
   */
  state(at: number = this.clock.now()): SessionState {
    const exit = this.pty.exitInfo;
    return {
      running: exit === null,
      idleMs: this.idleMs(at),
      drained: this.drained(),
      bytesPending: this.pendingBytes(),
      inputUnconsumed: this.pty.unconsumedBytes,
      exit,
    };
  }

  /**
   * Wait for the session to be quiet and caught up, or for the wait to end.
   *
   * Both halves are required, and the pairing is the point: quiet on its own
   * would return while a large feed was still being parsed, and a caller
   * reading the screen then would be reading one that is behind.
   *
   * It resolves on observation rather than on a fixed step: a byte arriving, a
   * feed finishing and the process exiting all wake it, and otherwise it
   * sleeps exactly until the moment the answer could change. A caller never
   * invents the interval, which is the whole point -- guessing how long to
   * wait is how a driver silently succeeds at nothing.
   *
   * `idle` is not "finished". It says the quiet period was observed; whether
   * the program is done is not something a byte interface can establish, and
   * the result deliberately does not claim it.
   */
  async waitForIdle(options: WaitOptions): Promise<WaitResult> {
    // All three reasons this wait can end on carry the same fields, so the
    // object is built in one place: the branches differ only in which reason
    // they name, and writing that object out three times is how the fields
    // drift apart between them.
    const ended = (reason: WaitReason, state: SessionState): Omit<WaitResult, 'waitedMs'> => ({
      reason,
      state,
      seq: this.seq,
    });
    return this.wait<Omit<WaitResult, 'waitedMs'>>({
      timeoutMs: options.timeoutMs,
      found: (state) =>
        state.drained === true && state.idleMs !== null && state.idleMs >= options.idleMs
          ? ended('idle', state)
          : null,
      // Nothing more can arrive once the process is gone and its output has
      // been parsed, so sitting out a quiet period would no longer be evidence
      // of anything. Ending here rather than waiting for one.
      onExit: (state) => ended('exited', state),
      // Named rather than left to `wait`'s bare fallback, which builds a
      // `timeout` with no fields beyond the reason and the state.
      onTimeout: (state) => ended('timeout', state),
      // Not drained, there is no moment to compute: only the pipeline knows
      // when it will finish, so this waits on the change rather than on a
      // clock. Drained, it waits exactly until the quiet period would elapse.
      until: (state, now, deadline) => {
        const remaining =
          state.drained === true && state.idleMs !== null ? options.idleMs - state.idleMs : Infinity;
        return Math.min(deadline, now + remaining);
      },
    });
  }

  /**
   * Wait for a pattern to appear in what the session produced.
   *
   * The sibling of `waitForIdle`, and the difference is the shape of the
   * observation. Idle is *negative* -- nothing arrived for a while -- so it
   * needs a quiet period to elapse before it means anything. A match is
   * *positive*: it is visible the moment it is on screen, so there is no
   * interval to observe and no `idleMs` to ask for. Waiting for a prompt is
   * then one call instead of wait-then-read-then-eyeball.
   *
   * What is matched, and against when:
   *
   *  - **Rows** (`surface: 'screen'`) this session *wrote* since the baseline.
   *    Wrote, not differs: a row that scrolled is not a row that appeared, and
   *    the two are told apart by the delivery's runs rather than by comparing
   *    text, which a scroll of identical content would defeat. The baseline is
   *    a byte watermark, so a prompt the caller already saw cannot match no
   *    matter how long it sits on screen.
   *  - **Completed lines** (`surface: 'text'`) each delivery emitted, stamped
   *    with the byte they completed at. This is the only sink that can still
   *    see a line that scrolled out of the viewport -- and the only one that
   *    cannot see a prompt, which the cursor is still on and which is
   *    therefore not a completed line (`text-log.ts`).
   *
   * Text has no catch-up, and the limit is worth naming: the session keeps no
   * line history (`TextLog` drains as it goes) and retention is a deployment
   * concern, so a line is matched from the moment the wait begins. Rows do
   * catch up, from the per-row watermark. Reading text that already went past
   * is history's group, not a wait's.
   *
   * The result is an observation and not a verdict. The tty echoes what was
   * typed, so an echo is new output and the row carrying it is new by every
   * definition above; a pattern that matches the echo is reported as a match,
   * with the text it matched. Whether that was the program answering or the
   * terminal repeating is the caller's judgement, as everywhere else.
   */
  async waitForOutput(options: WaitForOutputOptions): Promise<OutputWaitResult> {
    const surface: MatchSurface = options.surface ?? 'both';
    const sinceByte = options.sinceByte ?? this.pty.lastInputByte;
    const pattern = options.pattern;

    let hit: OutputMatch | null = null;

    // Subscribed before the catch-up scan, so content cannot fall between the
    // two. A delivery is the moment its part is fully parsed, which is why the
    // screen is tested here rather than in the loop below: there, a feed being
    // parsed has not decremented `pendings` yet, so `drained` still reads false
    // and a condition on it would test nothing at all.
    const off = this.onDelivery((delivery) => {
      if (hit) return;
      const found = this.matchDelivery(surface, pattern, sinceByte, delivery);
      if (found) {
        hit = found;
        this.wake();
      }
    });

    // The result has two shapes and only two, which is the rule `screen`
    // documents: a match is the answer when there is one, and the screen is the
    // answer when there is not. Building them here rather than at each of the
    // three branches is what keeps that rule true -- a fourth branch added
    // later gets it for free instead of re-deciding which fields to carry.
    const outcome = {
      matched: (match: OutputMatch, state: SessionState): Omit<OutputWaitResult, 'waitedMs'> => ({
        reason: 'matched',
        match,
        screen: null,
        state,
        sinceByte,
        seq: this.seq,
      }),
      endedOn: (
        reason: 'exited' | 'timeout',
        state: SessionState,
      ): Omit<OutputWaitResult, 'waitedMs'> => ({
        reason,
        match: null,
        screen: this.screen.snapshot(),
        state,
        sinceByte,
        seq: this.seq,
      }),
    };

    try {
      // Awaited inside the `try`, not returned straight out of it: the
      // `finally` below unsubscribes, and returning an unresolved promise would
      // run it immediately, unsubscribing before the wait saw anything.
      // Read once, and only once: everything written after this point arrives
      // as a delivery and is tested as it lands, so re-scanning the grid on
      // every wake would only re-check rows that cannot have changed.
      if (surface !== 'text') hit = hit ?? this.matchScreen(pattern, sinceByte);

      return await this.wait<Omit<OutputWaitResult, 'waitedMs'>>({
        timeoutMs: options.timeoutMs,
        found: (state) => (hit ? outcome.matched(hit, state) : null),
        // Nothing more can arrive and nothing matched, so waiting longer cannot
        // change the answer -- the same early end as `waitForIdle`, for the
        // same reason: the quiet period would no longer be evidence.
        onExit: (state) => outcome.endedOn('exited', state),
        onTimeout: (state) => outcome.endedOn('timeout', state),
      });
    } finally {
      off();
    }
  }

  /**
   * Wait for the next group — the next unit of output the program produced as
   * one act.
   *
   * The third wait, and the one a TUI needs. `waitForIdle` is *negative* --
   * nothing arrived for a while -- so it cannot tell a program that is
   * thinking from one that is waiting for you, and it returns whether or not
   * anything actually happened. `waitForOutput` is *positive* but needs a
   * pattern, and a repainting menu has no stable text to anchor on. A group is
   * positive and content-agnostic: it ends when the program's own act ends.
   *
   * **A group boundary is inferred from silence, not declared** (`groups.ts` calls
   * it "a fallback, not the truth"). So this is not *more* correct than idle,
   * it is better aimed: it ends on the unit the classifier already computes.
   *
   * Subscribed to updates rather than to the group's close, because at close
   * time nothing exists yet: the detector's callback is
   * `feed(group.bytes, group).then(deliver)`, and feed is async and queued. A
   * waiter woken at close would have to read again to see what the group was --
   * the round trip that makes a wait useless. `onUpdate` delivers the whole
   * object atomically, so one call returns group, screen and reason together.
   *
   * `sinceSeq` is the same number `seq` reports: a state in the timeline, not
   * a count of updates. Without it a fast program can close a group before the
   * wait begins, and the waiter would return the *previous* group -- output from
   * before the input was sent, which is the bug `waitForOutput`'s `sinceByte`
   * exists to prevent.
   *
   * The other half of that baseline is that a group which closed **after** it
   * must still be offered, even though it closed before this call. The window
   * is not small: the caller's round trip between sending input and waiting on
   * it is the latency of a model, so a program that repaints in 70ms has
   * finished its act long before the wait is issued. Listening for the next
   * group alone would sleep to the deadline with the answer already in hand --
   * measured on a driving run, where two of three group waits timed out for 20s
   * and 8s over an act that `read_screen` returned immediately after.
   * So `_lastUpdate` is read once, after subscribing, and the same `seq >
   * sinceSeq` test decides it.
   *
   * Every close reason is reported, because they do not mean the same thing:
   * `bytes` and `chunks` are caps cutting a group open **while the program is
   * still writing**, and `gap` is the only one that means the program went
   * quiet on its own. `timeout` is the bound that always holds, since a
   * policy without caps never closes a firehose group at all.
   */
  async waitForGroup(options: WaitForGroupOptions): Promise<GroupWaitResult> {
    // The state the caller has already seen. Anything at or before it is
    // content it has had, whatever produced it.
    const sinceSeq = options.sinceSeq ?? this._lastInputSeq;

    // Held in a box, not a bare `let`: TypeScript narrows a variable assigned
    // only inside a closure to `never` at the point it is read.
    const box: { found: SessionUpdate | null } = { found: null };
    let disposed = false;

    // Caught up before subscribing is wrong in the other direction -- a group
    // could land between the scan and the subscription -- so subscribe first,
    // then scan, exactly as `waitForOutput` does.
    const off = this.onUpdate((update) => {
      if (box.found) return;
      if (update.seq <= sinceSeq) return;
      // A group's update is the one that closed it. Without grouping every
      // update is its own group, so each one ends the wait -- which is correct:
      // there is nothing to group, and the caller gets output as it arrives.
      box.found = update;
      this.wake();
    });
    const offDispose = this.onDispose(() => {
      disposed = true;
      this.wake();
    });

    // The catch-up: an act that closed after the baseline but *before* this
    // call subscribed is the answer to the question just asked, and it is the
    // common case for an agent, whose round trip between a send and a wait is
    // seconds rather than milliseconds. Nothing will wake the listener above
    // for a group that has already closed, so it is read here -- after the
    // subscription, never before, so a group landing in between is not lost.
    // `seq > sinceSeq` is the same baseline test the listener makes, so a group
    // the caller has already seen is still not offered again.
    if (!box.found && this._lastUpdate && this._lastUpdate.seq > sinceSeq) {
      box.found = this._lastUpdate;
    }

    // The three ways to end without a group carry the same twelve fields and
    // differ in exactly two: the reason, and whether there is a screen to show
    // -- `disposed` has none, since the listeners are gone with the model that
    // would have produced one. Built in one place so a field added later cannot
    // reach two of the three and quietly miss the third.
    const noGroup = (
      reason: Exclude<GroupWaitReason, 'group'>,
      screen: ScreenSnapshot | null,
      state: SessionState,
    ): Omit<GroupWaitResult, 'waitedMs'> => ({
      reason,
      afterInput: null,
      seq: this.seq,
      group: null,
      collapsed: null,
      text: null,
      segments: null,
      changedRows: null,
      io: null,
      screen,
      state,
      sinceSeq,
    });

    try {
      // Awaited inside the `try`, not returned straight out of it: the
      // `finally` below unsubscribes, and a `return` of an unresolved promise
      // would run it immediately -- unsubscribing before the wait ever saw
      // anything, which is a wait that can only ever time out.
      return await this.wait<Omit<GroupWaitResult, 'waitedMs'>>({
        timeoutMs: options.timeoutMs,
        found: (state) => {
          const found = box.found;
          if (found) {
            return {
              reason: 'group',
              afterInput: this.afterInput(found),
              seq: found.seq,
              group: found.group,
              collapsed: found.collapsed,
              text: found.text,
              segments: found.segments,
              changedRows: found.changedRows,
              io: found.io,
              screen: found.screen,
              state,
              sinceSeq,
            };
          }
          // Disposed: the listeners were cleared, so nothing will ever arrive.
          // Ending here with a reason rather than letting the deadline run out,
          // which would look like a timeout the caller has to interpret.
          if (disposed) {
            return noGroup('disposed', null, state);
          }
          return null;
        },
        onExit: (state) => noGroup('exited', this.screen.snapshot(), state),
        // Nothing arrived and no group is coming. The wait reports the screen it
        // is looking at *and* the state that screen is at -- `seq` is the
        // current state, not `sinceSeq`, because `sinceSeq` labels a different
        // frame than the one being returned and a caller addressing the screen
        // with it read history from before its own input. Measured on a driving
        // run: a timeout at `seq: 33` beside a screen 4 states newer, and a
        // driver that re-read to get an addressable screen the response had
        // already handed it.
        onTimeout: (state) => noGroup('timeout', this.screen.snapshot(), state),
      });
    } finally {
      off();
      offDispose();
    }
  }

  /**
   * Rows written since the baseline, against the screen as it is now.
   *
   * This is the catch-up the caller needs because the content it is waiting for
   * may have arrived while it was doing something else: between a send and a
   * wait there is a round trip, and for an agent that round trip is not
   * milliseconds.
   */
  private matchScreen(pattern: RegExp, sinceByte: number): OutputMatch | null {
    const snapshot = this.screen.snapshot();
    for (let y = 0; y < snapshot.lines.length; y++) {
      const writtenAt = this.rowWrittenAt[y] ?? 0;
      if (writtenAt <= sinceByte) continue;
      const hit = matchRow(pattern, y, snapshot.lines[y] ?? '', writtenAt, snapshot.buffer);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * One delivery, tested as it lands.
   *
   * `toByte <= sinceByte` is content produced at or before the baseline, which
   * the caller has already had -- the whole reason a baseline exists.
   */
  private matchDelivery(
    surface: MatchSurface,
    pattern: RegExp,
    sinceByte: number,
    delivery: Delivery,
  ): OutputMatch | null {
    if (delivery.toByte <= sinceByte) return null;

    if (surface !== 'screen') {
      for (const line of delivery.text) {
        const hit = matchLine(pattern, line);
        if (hit) return hit;
      }
    }

    if (surface !== 'text') {
      // The rows this delivery wrote. No delta means no delta could describe
      // the change -- a full repaint, or a switch of buffer -- so every row of
      // the screen it produced counts as new.
      const rows = delivery.grid
        ? new Set(delivery.grid.runs.map((run) => run.y))
        : delivery.screen.lines.map((_, y) => y);
      for (const y of rows) {
        const hit = matchRow(
          pattern,
          y,
          delivery.screen.lines[y] ?? '',
          delivery.toByte,
          delivery.screen.buffer,
        );
        if (hit) return hit;
      }
    }

    return null;
  }

  /**
   * Record which rows a delivery wrote, and at which byte.
   *
   * Called for every delivery, whether or not anything is waiting: the
   * watermark is a fact about what the session did, and one computed only while
   * a caller happens to be waiting would be missing exactly the content a
   * catch-up exists to find.
   */
  private noteWritten(grid: GridDelta | null, toByte: number): void {
    const rows = this.screen.rows;
    if (this.rowWrittenAt.length !== rows) this.rowWrittenAt = new Array<number>(rows).fill(0);
    if (!grid) {
      this.rowWrittenAt.fill(toByte);
      return;
    }
    for (const run of grid.runs) {
      if (run.y >= 0 && run.y < rows) this.rowWrittenAt[run.y] = toByte;
    }
  }

  /** The byte watermark at the last write into the pty. See `PtySession`. */
  get lastInputByte(): number {
    return this.pty.lastInputByte;
  }

  /**
   * Whether an update's bytes start after the last input was written.
   *
   * `null` before any input, because "no input has been sent" and "this output
   * did not follow it" are different facts and `null`/`0` conflation is the
   * bug this exists to prevent.
   *
   * Compares byte watermarks, not time: the input watermark is stamped on the
   * way in and every byte read carries its own offset, so this is arithmetic on
   * two measured counts. It says nothing about causation — output that follows
   * input may still be unrelated to it — but it is the one causal fact a byte
   * interface can state without guessing.
   */
  private afterInput(update: SessionUpdate): boolean | null {
    const written = this.pty.bytesWritten;
    if (written === 0) return null;
    return update.fromByte >= this.pty.lastInputByte;
  }

  /**
   * Whether nothing more can arrive: the process is gone and everything it
   * wrote has been through the parser.
   *
   * Named because every wait ends early on it, and because the two halves are
   * easy to get wrong separately -- an exit with output still in the pipeline
   * is the window a wait exists to sit in, and `drained` alone would close it.
   */
  private finished(state: SessionState): boolean {
    return state.exit !== null && state.drained === true;
  }

  /**
   * The skeleton every wait on this session shares.
   *
   * Three waits, three different things they are looking for, and one loop they
   * would otherwise each have written: re-read the state, ask whether the wait
   * is over, sleep until the moment the answer could change, and stop at the
   * deadline. Three copies of that is how one guarantee holds in two places and
   * quietly does not in the third -- the exit check in `waitForIdle` and the one
   * in `waitForOutput` were already drifting apart in what they reported.
   *
   * What genuinely differs is passed in, and each piece fires at a different
   * point in the loop:
   *
   *  - `found` -- the positive condition, asked on every wake, including the
   *    first one before anything is awaited. A wait must be able to return
   *    without sleeping: content that arrived while the caller was doing
   *    something else is already there, and a wait that sleeps before looking
   *    is the bug the baseline parameters exist to prevent.
   *  - `onExit` -- asked only once the process is gone and its output has been
   *    parsed. Nothing more can arrive then, so a quiet period would no longer
   *    be evidence of anything and the wait ends early rather than sitting out
   *    a deadline that no longer means anything.
   *  - `onTimeout` -- what to report when the deadline ran out, so a wait can
   *    carry its own fields instead of only a reason: a caller that timed out
   *    needs the screen and the state to decide what to do next, and without
   *    this it would have to read again to find out.
   *  - `until` -- the moment this wait could next have an answer, defaulting to
   *    the deadline. `waitForIdle` is the one that needs it: it waits for a
   *    quiet period to *elapse*, which is a time it can compute, so it sleeps
   *    exactly that long instead of waking on every byte.
   *
   * `waitedMs` is measured here, on the session's clock, so all three report
   * the same quantity the same way.
   */
  private async wait<T>(options: {
    timeoutMs: number;
    found: (state: SessionState) => T | null;
    onExit?: (state: SessionState) => T | null;
    onTimeout?: (state: SessionState) => T | null;
    until?: (state: SessionState, now: number, deadline: number) => number;
  }): Promise<T & { waitedMs: number }> {
    const startedAt = this.clock.now();
    const deadline = startedAt + options.timeoutMs;

    for (;;) {
      const now = this.clock.now();
      const state = this.state(now);

      // `found` is asked *first*, and that ordering is load-bearing: a session
      // can exit having already produced the thing being waited for, and an
      // exit checked first would report `exited` while dropping the group that
      // arrived. The wait's own condition is the more specific answer whenever
      // it holds.
      const hit = options.found(state);
      if (hit) return { ...hit, waitedMs: now - startedAt };

      // Ends the wait only when `onExit` has something to say. A wait with no
      // exit shape keeps running to the deadline: it is waiting for content,
      // and an exit that produced none is a reason to stop only if it says so.
      if (this.finished(state)) {
        const ended = options.onExit?.(state);
        if (ended) return { ...ended, waitedMs: now - startedAt };
      }

      if (now >= deadline) {
        const ended = options.onTimeout?.(state);
        if (ended) return { ...ended, waitedMs: now - startedAt };
        return { reason: 'timeout', state, waitedMs: now - startedAt } as unknown as T & {
          waitedMs: number;
        };
      }

      const at = options.until ? options.until(state, now, deadline) : deadline;
      // A bound, not a step: this resolves at that moment, or when the session
      // changes, whichever comes first. Nothing here wakes on a fixed step.
      await this.nextChange(Math.min(deadline, at));
    }
  }

  /**
   * Wake anything waiting on this session changing.
   *
   * Called wherever the facts a wait reads can change: a byte arriving, a feed
   * finishing, an exit. None of them decides whether the change matters -- the
   * waiter re-reads the state and decides for itself.
   */
  private wake(): void {
    if (this.waiters.length === 0) return;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /**
   * Resolve on the session changing, or at `at` on the clock, whichever is
   * first. `at` is a bound, not a poll: nothing here wakes on a fixed step.
   */
  private nextChange(at: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: unknown;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.clock.clear(timer);
        const i = this.waiters.indexOf(finish);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      this.waiters.push(finish);
      timer = this.clock.set(finish, Math.max(0, at - this.clock.now()));
    });
  }

  /**
   * Whether everything the pty handed us has been through the parser.
   *
   * A queued feed is answered first and settles it: bytes are in flight, so
   * the answer is no regardless of what the counters say. `null` only when the
   * counters cannot be compared at all.
   */
  private drained(): boolean | null {
    if (this.pendings > 0) return false;
    const pending = this.pendingBytes();
    if (pending === null) return null;
    return pending === 0;
  }

  /**
   * Bytes the pty handed us that the parser has not finished with.
   *
   * `null` when the parser has also been fed from somewhere other than the
   * pty — the two counters are then not a difference of the same thing.
   */
  private pendingBytes(): number | null {
    const read = this.pty.bytesRead;
    if (this._bytesParsed > read) return null;
    return read - this._bytesParsed;
  }

  /**
   * The state the session is at now, in the numbering every `seq` reports.
   *
   * The **raw delivery** counter, not `_seq`: `_seq` counts classified updates,
   * and grouping makes the two diverge by however many deliveries a group
   * swallowed. Everything a caller can address -- `SessionUpdate.seq`,
   * `history_read`'s addresses, `sinceSeq` -- uses the raw numbering, so a
   * getter named `seq` that returned the update counter handed back a number
   * that matched nothing else and silently broke comparisons against it.
   */
  get seq(): number {
    return this._rawSeq;
  }

  /**
   * Resize the pty and the screen together, so they never disagree.
   *
   * Validated once here, before either is touched: if each half validated on
   * its own, one could accept the size and the other throw, leaving a session
   * with a pty at one size and a screen at another.
   *
   * The resize itself is applied synchronously -- the program inside must be
   * told promptly -- but the *notification* is queued. A caller recording the
   * boundary needs it ordered against the output, and a resize that overtook a
   * delivery in flight would be recorded as having happened before output that
   * was produced at the old size.
   *
   * A pending group is flushed first, because a group may not straddle a boundary
   * that freezes history: everything before a resize belongs to the old epoch
   * at the old size. The group is closed but its bytes are still
   * fed through the queue, so they may land after the resize applies -- which
   * is the case `history.ts` already handles by deriving epochs from the size
   * a record reports rather than trusting the resize event.
   */
  resize(cols: number, rows: number): void {
    assertGridSize(cols, rows);
    this.groups?.flush();
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
    // The old stamps describe rows of a grid that no longer exists. Everything
    // counts as written at the resize, so a baseline from before it sees the
    // whole screen as new rather than as stale-but-unknown -- a resize re-presents
    // content, and saying a row is old there would be a claim nothing supports.
    this.rowWrittenAt = new Array<number>(rows).fill(this.screen.ops.bytesFed);
    this.enqueue(() => {
      for (const listener of this.resizeListeners) listener({ cols, rows });
    });
  }

  /**
   * End the session.
   *
   * `pty.dispose()` kills the process tree itself, so there is no separate
   * kill to remember here.
   */
  dispose(): void {
    // Dropped, not kept: a disposed session will never produce another act, so
    // its last one is not "the next group" for any wait that follows. Exit is
    // deliberately not treated this way -- a program that produced a group and
    // then exited did produce that group, and `wait` asks `found` before it
    // asks whether the session ended.
    this._lastUpdate = null;
    // Before anything is cleared, so a waiter can be told the session is gone
    // rather than sitting out its deadline and looking like a timeout.
    for (const listener of this.disposeListeners.splice(0)) listener();
    this.listeners.length = 0;
    this.resizeListeners.length = 0;
    this.exitListeners.length = 0;
    this.disposeListeners.length = 0;
    this.groups?.dispose();
    this.screen.dispose();
    this.pty.dispose();
    // Anything waiting is waiting on a session that will never change again.
    this.wake();
  }
}

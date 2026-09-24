/**
 * L0.3 — history is a single interleaved timeline.
 *
 * One append-only timeline per session holds everything: all writing and all
 * screen states, in true chronological order. The agent can page back, seek to
 * a point in time or a point in the sequence, and retrieve the terminal *as it
 * was* -- text, screen, or mixture. A session that starts as a build log and
 * then drops into a TUI keeps both, in order, with the transition visible.
 *
 * ## Resize is a boundary
 *
 * A resize **freezes** the history produced before it, and any query against
 * that history reports the grid size that was in effect where it was produced.
 * After a resize, history is new. So a session's history is a sequence of
 * **epochs**, one per grid size, split where the size changed.
 *
 * This is not a bookkeeping choice, it is what makes the stored form
 * well-defined. Inside one epoch the width is fixed, so a row-run delta means
 * one thing, and a captured line's wrapping is unambiguous. Across a resize
 * neither is true, which is exactly why nothing here ever reflows: a frozen
 * epoch keeps the size it was produced at and is reported at that size.
 *
 * Freezing costs nothing, because every stored screen is already a deep copy
 * carrying its own `cols`/`rows` (`screen.ts`) -- epochs are an *index* over an
 * already-frozen log, not a transformation of it.
 *
 * ## Epochs are derived from the records, not trusted to an event
 *
 * `TerminalSession.resize()` reports a boundary, but that notification is
 * queued behind deliveries already in flight, while the resize itself applies
 * to the screen synchronously. A delivery queued before a resize and run after
 * it therefore reports the *new* size, ahead of the boundary that would have
 * opened the new epoch.
 *
 * Rather than depend on that ordering, an epoch is split whenever a record
 * arrives whose size differs from the current epoch's. The notification then
 * covers only what a record cannot: a resize that produced no output at all,
 * which must still be visible and must still freeze what came before.
 *
 * ## What is stored
 *
 * A record keeps the classified segments (CLASSIFIER.md §2 -- the list is what
 * this timeline wanted), the completed lines of that delivery, and either a
 * grid delta or a keyframe, never both. A keyframe is stored when a delta would
 * not have been smaller, and always at the start of an epoch, so every epoch is
 * self-contained and a read never has to reach outside it.
 */
import type { SessionId } from './types.js';
import { classify, frameFrom } from './classify.js';
import type { Segment } from './classify.js';
import type { TextLine } from './text-log.js';
import type { ScreenSnapshot } from './screen.js';
import type { GridDelta } from './delta.js';
import { applyDelta } from './delta.js';
import type { PtyExitInfo } from './pty.js';
import type { TerminalSession } from './session.js';

/**
 * An opaque address into a session's history.
 *
 * Opaque by contract (GOAL.md L3.2): callers pass it back, they do not parse
 * it. Retention may change what a position means underneath without breaking
 * anyone holding a token.
 */
export type HistoryToken = string;

/** A point to seek to. */
export type HistoryAddress =
  | { token: HistoryToken }
  | { seq: number }
  | { at: number }
  | { byte: number };

/**
 * Anything a caller can seek with.
 *
 * A bare token is accepted because that is what a read hands back -- `page.next`
 * should be passable straight in, not wrapped first.
 */
export type HistoryPoint = HistoryAddress | HistoryToken;

/**
 * One delivery as recorded — the canonical unit of this timeline.
 *
 * A delivery, not a job: the raw stream is the record, and the job the agent is
 * shown is a *projection* over it (`jobs`). That is the difference between
 * storing what happened and storing one account of what happened — a projection
 * can be recomputed at a different granularity, and cannot disagree with the
 * stream it came from because it is derived from it.
 *
 * Verdicts are deliberately absent. They are read off the screen like everything
 * else (`classify`), so storing them would be a second opinion that could drift
 * from the frames it was taken from.
 */
export interface HistoryRecord {
  seq: number;
  /** The job this delivery was grouped into. See `jobs`. */
  job: number;
  at: number;
  fromByte: number;
  toByte: number;
  /** Completed lines produced by this delivery, in order. */
  text: readonly TextLine[];
  /**
   * Rows the emulator reported the content moved during this delivery.
   *
   * Kept because the projection classifies a job from the screen before it to
   * the screen after it, and needs the scroll between them to compare the two
   * at the right offset. Recovering it afterwards would mean re-deriving it
   * from the grid, which is the guess `classify` exists to avoid.
   */
  scrolledRows: number;
  cursor: { x: number; y: number };
  buffer: 'normal' | 'alternate';
  /** What changed on the grid, or `null` when this record carries a keyframe. */
  grid: GridDelta | null;
  /** The whole screen, when this record is an anchor for reconstruction. */
  keyframe: ScreenSnapshot | null;
}

/**
 * What a timeline needs from one delivery.
 *
 * A live session's deliveries satisfy this; so does a replay, which is how the
 * corpus verifies the whole thing without a pty.
 */
export interface HistoryInput {
  seq: number;
  job: number;
  at: number;
  fromByte: number;
  toByte: number;
  text: readonly TextLine[];
  scrolledRows: number;
  grid: GridDelta | null;
  screen: ScreenSnapshot;
}

/** A grid size and the stretch of sequence it covers. */
export interface EpochInfo {
  index: number;
  cols: number;
  rows: number;
  openedAt: number;
  /** Set when the next epoch opened. `null` while this one is current. */
  closedAt: number | null;
  /** Sequence range this epoch covers. `null` until its first record. */
  fromSeq: number | null;
  toSeq: number | null;
  fromByte: number | null;
  toByte: number | null;
  records: number;
}

/**
 * How a session ended, once it has.
 *
 * Recorded because L0.3 requires history to survive the process exiting: the
 * last state is not "still changing", and a reader paging to the end deserves
 * to know that rather than infer it from silence.
 */
export interface HistoryEnd {
  at: number;
  exitCode: number | null;
  signal: number | null;
}

/** One bounded window of a timeline. */
export interface HistoryPage {
  /** The epoch the records came from — the grid size they were produced at. */
  epoch: EpochInfo;
  records: readonly HistoryRecord[];
  from: HistoryToken;
  /** Pass as `from` to read the next window. `null` at the end of the timeline. */
  next: HistoryToken | null;
  /** More records were available; the limit stopped the read. Reported, never silent (L1.1). */
  truncated: boolean;
  /** The page stopped because the next record is at a different grid size. */
  stoppedAtEpochEnd: boolean;
}

/**
 * A job as the agent was shown it — computed from the stream, never stored.
 *
 * `segments` are here and not on a `HistoryRecord` because a delivery cannot
 * carry a verdict the projection would agree with: the job's span is what was
 * measured, so the job is what can be classified.
 */
export interface JobRecord {
  /** The job's sequence number; the same one its update carried. */
  job: number;
  at: number;
  fromByte: number;
  toByte: number;
  /** The verdict over the whole span, from the screen before it to after it. */
  segments: readonly Segment[];
  /** Completed lines across the span, in order. */
  text: readonly TextLine[];
  screen: ScreenSnapshot;
  cursor: { x: number; y: number };
  buffer: 'normal' | 'alternate';
  /** How many raw deliveries this job stands for. */
  chunks: number;
}

/** One bounded window of a timeline's text. */
export interface TextPage {
  epoch: EpochInfo;
  lines: readonly TextLine[];
  next: HistoryToken | null;
  truncated: boolean;
  stoppedAtEpochEnd: boolean;
}

interface Epoch {
  info: EpochInfo;
  records: HistoryRecord[];
}

const DEFAULT_LIMIT = 50;

/**
 * The timeline for one session.
 *
 * Construct with the session id and `attach` it to the session; the store does
 * both in one call. Recording is deliberately separable from the subscription
 * so a replay can drive the same code path the server does.
 */
export class SessionHistory {
  readonly sessionId: SessionId;

  private readonly list: Epoch[] = [];
  private _ended: HistoryEnd | null = null;

  constructor(sessionId: SessionId) {
    this.sessionId = sessionId;
  }

  /** How the session ended, or `null` while it is still running. */
  get ended(): HistoryEnd | null {
    return this._ended;
  }

  /**
   * Start recording a live session. Returns a detach function.
   *
   * Epoch 0 is opened here rather than on first output, so a session that is
   * created and never speaks still has a timeline with a size.
   */
  attach(session: TerminalSession): () => void {
    if (this.list.length === 0) {
      this.openEpoch(session.screen.cols, session.screen.rows);
    }
    const offs = [
      // Deliveries, not updates: this timeline records the stream, and the
      // job the agent is shown is projected from it on read.
      session.onDelivery((delivery) => this.push(delivery)),
      session.onResize((size) => this.resize(size.cols, size.rows)),
      session.onExit((info) => this.end(info)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /** Every epoch, oldest first. The last one is the current one. */
  epochs(): readonly EpochInfo[] {
    return this.list.map((e) => e.info);
  }

  /**
   * Record one delivery.
   *
   * Splits the epoch first if this delivery's grid does not match it, so an
   * epoch only ever holds records of one size regardless of how the resize
   * notification was ordered against the output.
   */
  push(update: HistoryInput): void {
    const { cols, rows } = update.screen;
    if (this.list.length === 0) this.openEpoch(cols, rows);
    const epoch = this.current();
    if (epoch.info.cols !== cols || epoch.info.rows !== rows) {
      this.openEpoch(cols, rows);
    }
    const target = this.current();

    // An epoch's first record must carry the state it starts from, or the
    // epoch is not readable on its own. A declined delta is a whole screen in
    // runs, so a keyframe is no larger -- store the state and drop the delta.
    const isAnchor = target.records.length === 0 || update.grid === null;

    target.records.push({
      seq: update.seq,
      job: update.job,
      at: update.at,
      fromByte: update.fromByte,
      toByte: update.toByte,
      text: update.text,
      scrolledRows: update.scrolledRows,
      cursor: { x: update.screen.cursorX, y: update.screen.cursorY },
      buffer: update.screen.buffer,
      grid: isAnchor ? null : update.grid,
      keyframe: isAnchor ? update.screen : null,
    });

    target.info.records = target.records.length;
    target.info.toSeq = update.seq;
    target.info.toByte = update.toByte;
    target.info.fromSeq ??= update.seq;
    target.info.fromByte ??= update.fromByte;
  }

  /**
   * Record a grid-size change.
   *
   * A no-op when the current epoch already has that size, which is the common
   * case: the records themselves usually split the epoch first, and this
   * notification exists for the resize that produced no output at all.
   */
  resize(cols: number, rows: number): void {
    if (this.list.length === 0) {
      this.openEpoch(cols, rows);
      return;
    }
    const epoch = this.current();
    if (epoch.info.cols === cols && epoch.info.rows === rows) return;
    this.openEpoch(cols, rows);
  }

  /** Record that the session ended. History stays readable afterwards. */
  end(info: PtyExitInfo): void {
    if (this._ended) return;
    this._ended = { at: Date.now(), exitCode: info.exitCode, signal: info.signal };
    this.current().info.closedAt = this._ended.at;
  }

  /**
   * Read a bounded window of records.
   *
   * A page never spans an epoch boundary: every page reports the grid size its
   * records were produced at, so a caller is never handed two sizes at once.
   * Crossing is a matter of reading again -- `next` addresses the first record
   * of the next epoch.
   */
  read(options: { from?: HistoryToken; limit?: number } = {}): HistoryPage {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const start = options.from === undefined ? { epoch: 0, index: 0 } : this.decode(options.from);
    const epoch = this.list[start.epoch];
    if (!epoch) throw new RangeError(`no such history position: ${options.from}`);

    const records: HistoryRecord[] = [];
    let index = start.index;
    let truncated = false;
    for (; index < epoch.records.length; index++) {
      const record = epoch.records[index];
      if (!record) break;
      if (records.length === limit) {
        truncated = true;
        break;
      }
      records.push(record);
    }

    const stoppedAtEpochEnd = index >= epoch.records.length;

    return {
      epoch: epoch.info,
      records,
      from: this.encode(start.epoch, start.index),
      next: this.resumeAt(start.epoch, index),
      truncated,
      stoppedAtEpochEnd,
    };
  }

  /**
   * The screen as it was at an address, at the size it was produced at.
   *
   * Materialized from the nearest keyframe plus the deltas after it, so a point
   * inside a run of drawing costs a few of splices rather than a replay.
   * Returns `null` when the address is before anything recorded.
   */
  screenAt(address: HistoryPoint | undefined): ScreenSnapshot | null {
    const found = this.locate(address);
    if (!found) return null;
    return this.screenInEpoch(found.epoch, found.index);
  }

  /** The screen one record in an epoch produced, folded from the keyframe before it. */
  private screenInEpoch(epoch: Epoch, index: number): ScreenSnapshot | null {
    const record = epoch.records[index];
    if (!record) return null;

    let i = index;
    while (i > 0 && !epoch.records[i]?.keyframe) i--;
    const anchor = epoch.records[i]?.keyframe;
    if (!anchor) return null;

    let screen = anchor;
    for (let j = i + 1; j <= index; j++) {
      const at = epoch.records[j];
      if (!at) continue;
      if (at.keyframe) screen = at.keyframe;
      else if (at.grid) screen = applyDelta(screen, at.grid);
    }

    // The cursor is not part of a delta; it belongs to the record being read.
    return {
      ...screen,
      cursorX: record.cursor.x,
      cursorY: record.cursor.y,
      buffer: record.buffer,
    };
  }

  /**
   * The deliveries in a sequence range, each with the screen it produced.
   *
   * The stream read straight: every delivery the session emitted, in order,
   * with its state reconstructed. This is what `collapsed.intermediates`
   * promises — the states a job swallowed, playable back — and it lives here
   * because the stream is this timeline's, not the session's.
   */
  deliveries(from: number, to: number): Array<HistoryRecord & { screen: ScreenSnapshot }> {
    const out: Array<HistoryRecord & { screen: ScreenSnapshot }> = [];
    for (const epoch of this.list) {
      for (let i = 0; i < epoch.records.length; i++) {
        const record = epoch.records[i]!;
        if (record.seq < from || record.seq > to) continue;
        const screen = this.screenInEpoch(epoch, i);
        if (screen) out.push({ ...record, screen });
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * The deliveries grouped into the jobs the agent was shown.
   *
   * The projection the canonical stream exists for. A job is classified from
   * the screen before its first delivery to the screen after its last, across
   * the whole span — which is what makes a repaint legible where no single
   * delivery could show it. Nothing is stored per job; this is computed from
   * the records every time it is asked for, so it cannot disagree with them.
   */
  jobs(options: { limit?: number } = {}): JobRecord[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const out: JobRecord[] = [];
    for (const epoch of this.list) {
      for (let i = 0; i < epoch.records.length && out.length < limit; i++) {
        const first = epoch.records[i]!;
        // Only from a job's first delivery: a job never straddles an epoch,
        // because a resize forces one closed (HISTORY.md §2).
        if (i > 0 && epoch.records[i - 1]!.job === first.job) continue;

        const group: HistoryRecord[] = [];
        for (let j = i; j < epoch.records.length && epoch.records[j]!.job === first.job; j++) {
          group.push(epoch.records[j]!);
        }

        const after = this.screenInEpoch(epoch, i + group.length - 1);
        if (!after) continue;
        // What the job started from: the delivery before it, or the epoch's
        // first keyframe when the job opens the epoch.
        const beforeScreen = i > 0 ? this.screenInEpoch(epoch, i - 1) : null;
        const before = frameFrom(beforeScreen ?? after);
        const scrolledBy = group.reduce((n, r) => n + r.scrolledRows, 0);
        const classified = classify({
          before,
          after: frameFrom(after),
          fromByte: first.fromByte,
          toByte: group[group.length - 1]!.toByte,
          scrolledBy,
        });

        out.push({
          job: first.job,
          at: first.at,
          fromByte: first.fromByte,
          toByte: group[group.length - 1]!.toByte,
          segments: classified.segments,
          text: group.flatMap((r) => r.text),
          screen: after,
          cursor: group[group.length - 1]!.cursor,
          buffer: after.buffer,
          chunks: group.length,
        });
      }
    }
    return out;
  }

  /**
   * The text recorded at or after an address, bounded and in order.
   *
   * Bounded to one epoch for the same reason a page is: the lines were wrapped
   * at that epoch's width, and mixing widths in one answer would leave the
   * caller unable to say what a line's shape means.
   *
   * With no address this reads from the beginning, which is the useful reading
   * of "give me the text" -- unlike `screenAt`, where no address means "now".
   *
   * A page is `limit` lines **rounded up to a record boundary**, because a
   * record is what a token addresses. Splitting one would leave the caller
   * resuming from `next` either repeating lines it was already given or
   * skipping the ones it was not -- and skipping is the silent loss L1.1
   * forbids. So a record longer than `limit` is returned whole.
   */
  textSince(address: HistoryPoint | undefined, limit = DEFAULT_LIMIT): TextPage {
    const found = address === undefined ? null : this.locate(address);
    const epochIndex = found ? found.epoch.info.index : 0;
    const epoch = this.list[epochIndex];
    if (!epoch) throw new RangeError(`no such history position`);

    // Inclusive, like `read`'s `from`: `next` from a page is the first record
    // that page did not return, not the last one it did.
    const startIndex = found ? found.index : 0;
    const lines: TextLine[] = [];
    let index = startIndex;
    let truncated = false;
    for (; index < epoch.records.length; index++) {
      const record = epoch.records[index];
      if (!record) break;
      // `lines.length > 0` is what lets a record larger than the limit through:
      // refusing it would return nothing and hand back the same token, and a
      // caller paging on that would never move.
      if (lines.length > 0 && lines.length + record.text.length > limit) {
        truncated = true;
        break;
      }
      lines.push(...record.text);
    }

    const stoppedAtEpochEnd = index >= epoch.records.length;

    return { epoch: epoch.info, lines, next: this.resumeAt(epochIndex, index), truncated, stoppedAtEpochEnd };
  }

  /** Resolve any address to a token, for a caller that wants somewhere to resume. */
  tokenAt(address: HistoryPoint): HistoryToken | null {
    const found = this.locate(address);
    return found ? this.encode(found.epoch.info.index, found.index) : null;
  }

  /**
   * The record at or before an address, and its epoch.
   *
   * "At or before" rather than "exactly": seeking to a time or a byte offset
   * means asking what the terminal was like then, and the honest answer is the
   * last recorded state at or before that point. Delivery granularity is the
   * resolution limit and this does not invent precision beyond it.
   */
  private locate(point: HistoryPoint | undefined): { epoch: Epoch; index: number } | null {
    if (point === undefined) {
      // No address means "now": the most recent state there is.
      const epoch = this.list[this.list.length - 1];
      return epoch && epoch.records.length > 0
        ? { epoch, index: epoch.records.length - 1 }
        : null;
    }
    const address: HistoryAddress = typeof point === 'string' ? { token: point } : point;

    if ('token' in address) {
      const { epoch, index } = this.decode(address.token);
      const found = this.list[epoch];
      if (!found || !found.records[index]) return null;
      return { epoch: found, index };
    }

    const matches = (record: HistoryRecord): boolean => {
      if ('seq' in address) return record.seq <= address.seq;
      if ('at' in address) return record.at <= address.at;
      return record.fromByte <= address.byte;
    };

    let best: { epoch: Epoch; index: number } | null = null;
    for (const epoch of this.list) {
      for (let index = 0; index < epoch.records.length; index++) {
        const record = epoch.records[index];
        if (record && matches(record)) best = { epoch, index };
      }
    }
    return best;
  }

  private current(): Epoch {
    const epoch = this.list[this.list.length - 1];
    if (!epoch) throw new Error('history has no epoch');
    return epoch;
  }

  /**
   * Where a read that stopped at `index` of `epoch` should resume.
   *
   * The first record it did not return: the record itself when the limit
   * stopped the read mid-epoch -- both reads address a token inclusively --
   * otherwise the first record of whatever follows, or `null` at the end of the
   * timeline.
   *
   * Shared because the two reads have to agree about it, and they did not: the
   * text read handed back the record it stopped on while resuming past it, so
   * paging lost the rest of that record.
   */
  private resumeAt(epoch: number, index: number): HistoryToken | null {
    if (index < (this.list[epoch]?.records.length ?? 0)) return this.encode(epoch, index);
    return epoch + 1 < this.list.length ? this.encode(epoch + 1, 0) : null;
  }

  private openEpoch(cols: number, rows: number): void {
    const now = Date.now();
    const previous = this.list[this.list.length - 1];
    if (previous) previous.info.closedAt ??= now;
    this.list.push({
      info: {
        index: this.list.length,
        cols,
        rows,
        openedAt: now,
        closedAt: null,
        fromSeq: null,
        toSeq: null,
        fromByte: null,
        toByte: null,
        records: 0,
      },
      records: [],
    });
  }

  private encode(epoch: number, index: number): HistoryToken {
    return `h1.${epoch}.${index}`;
  }

  private decode(token: HistoryToken): { epoch: number; index: number } {
    const match = /^h1\.(\d+)\.(\d+)$/.exec(token);
    if (!match) throw new RangeError(`malformed history token: ${token}`);
    const epoch = Number(match[1]);
    const index = Number(match[2]);
    if (!this.list[epoch] || index > (this.list[epoch]?.records.length ?? 0)) {
      throw new RangeError(`no such history position: ${token}`);
    }
    return { epoch, index };
  }
}

/**
 * Every session's timeline, keyed by session id.
 *
 * Deliberately not part of `SessionRegistry`. Killing a session removes it from
 * the registry; it must not discard what that session did. The store is what
 * keeps a finished session's history readable afterwards, which is the whole of
 * L0.3's "history survives the process exiting".
 */
export class HistoryStore {
  private readonly histories = new Map<SessionId, SessionHistory>();

  /** Begin recording a session, or return the existing timeline for it. */
  open(session: TerminalSession): SessionHistory {
    const existing = this.histories.get(session.id);
    if (existing) return existing;
    const history = new SessionHistory(session.id);
    history.attach(session);
    this.histories.set(session.id, history);
    return history;
  }

  get(id: SessionId): SessionHistory | undefined {
    return this.histories.get(id);
  }
}

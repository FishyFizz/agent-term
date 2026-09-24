/**
 * Trace shapes.
 *
 * The corpus contract: a trace is the emulator's own record of a programme's
 * output — the op stream, screen frames, and the text log — plus the
 * *expectation* of how each segment should classify.
 *
 * Everything here is produced by feeding the bytes through `ScreenModel`,
 * which only ever reads the emulator. No field is derived by scanning the raw
 * bytes; that would be a second parser and CLASSIFIER.md §1 forbids it.
 *
 * The `Op` shape is the repo's one op vocabulary (src/edit-record.ts), not a
 * corpus-local copy: a trace is replayed through the same classifier that
 * reads a live session, so both have to mean the same thing by the same name.
 */
import type { Op } from '../../src/edit-record.js';

const CRLF = '\r\n';

/**
 * The sequence a programme emits to ask for a resize.
 *
 * A pty can only be resized by whoever owns it, and in pty mode the programme
 * runs in a child process that does not. So the request goes out in-band -- and
 * it has to be a sequence that renders **nothing**, or it defeats itself: a
 * printed marker sits on the grid, and ConPTY repaints the grid when it
 * resizes, so the marker comes back, is acted on again, and resizes forever.
 * Measured, with a visible marker: two requested resizes arrived as eleven.
 *
 * OSC 0 sets the window title, which is not part of the cell grid and is never
 * repainted as content. Verified to survive the pty and ConPTY intact, where a
 * DA-style sequence came through mangled. It is already in the op vocabulary as
 * `TITLECHANGE` -- evidence, not a segment -- so it does not disturb
 * classification either.
 */
const RESIZE_MARKER = /\x1b\]0;resize:(\d+)x(\d+)\x07/g;

export function resizeMarker(cols: number, rows: number): string {
  return `\x1b]0;resize:${cols}x${rows}\x07`;
}

/**
 * Find resize requests in a chunk of output, consuming what it matches.
 *
 * Returns the sizes asked for and what is left unconsumed, so a marker split
 * across two chunks is matched once it completes rather than missed.
 */
export function takeResizeMarkers(text: string): { sizes: Array<{ cols: number; rows: number }>; rest: string } {
  const sizes: Array<{ cols: number; rows: number }> = [];
  let rest = text;
  RESIZE_MARKER.lastIndex = 0;
  for (let m = RESIZE_MARKER.exec(rest); m; m = RESIZE_MARKER.exec(rest)) {
    sizes.push({ cols: Number(m[1]), rows: Number(m[2]) });
    rest = rest.slice(m.index + m[0].length);
    RESIZE_MARKER.lastIndex = 0;
  }
  return { sizes, rest };
}

/**
 * When a delivery arrived, and where it starts in the byte stream.
 *
 * `at` is the moment the bytes reached us — the programme's write in a direct
 * run, the pty's `data` event in a pty run. Not the moment they were fed to
 * the emulator: in a direct run the programme finishes before any feeding
 * starts, so a feed-time timestamp records the feeder's cadence and erases the
 * programme's. That mistake is why a trace used to show every delivery 15ms
 * apart whatever the programme did, and why no job boundary could be recovered
 * from one.
 */
export interface ArrivalAt {
  /** Byte offset this delivery starts at. */
  offset: number;
  /** Milliseconds, same clock as `Op.at`. */
  at: number;
}

/** A snapshot of the visible screen. */
export interface Frame {
  index: number;
  /** Optional label: what the programme had just done. */
  label?: string;
  /** Byte offset at capture time. */
  at: number;
  cursorY: number;
  cursorX: number;
  buffer: 'normal' | 'alternate';
  viewportY: number;
  /** `rows` strings, top to bottom, right-trimmed. */
  lines: string[];
}

/**
 * What the classifier is expected to say about one span of a trace.
 *
 * A span is a byte range, so an expectation is anchored in the same coordinate
 * space as the ops — it survives re-recording and it does not depend on how the
 * output was chunked into deliveries.
 */
export interface SegmentExpectation {
  /** Byte offset where the segment begins, inclusive. */
  from: number;
  /** Byte offset where it ends, exclusive. */
  to: number;
  /** The verdict the classifier must reach. */
  kind: 'writing' | 'drawing';
  /** What makes this case interesting — the reason it is in the corpus. */
  why: string;
  /**
   * `true` when the case is genuinely ambiguous and abstention
   * (`confidence: 'low'`, both representations sent) is the correct answer.
   */
  ambiguous?: boolean;
}

/** A resize a programme requested, and where in the byte stream it asked. */
export interface ResizeAt {
  /** Byte offset by which the marker asking for it had been written. */
  offset: number;
  cols: number;
  rows: number;
}

export interface Trace {
  version: 1;
  id: string;
  /** `basic` | `cli` | `complex` — the three families asked for. */
  category: string;
  /** One line: what this programme does. */
  summary: string;
  /** How the bytes reached the emulator. */
  feed: 'direct' | 'pty';
  cols: number;
  rows: number;
  platform: string;
  recordedAt: string;
  expectations: SegmentExpectation[];
  ops: Op[];
  frames: Frame[];
  textLog: string[];
  /**
   * Resizes the programme asked for, in order.
   *
   * Recorded because a replay has to apply them too, or it reads the trace at a
   * size the programme never saw. The history timeline splits its epochs here.
   */
  resizes: ResizeAt[];
  /**
   * When each delivery arrived, in order, as `{ offset, at }`.
   *
   * The byte stream alone cannot say where one act ended and the next began;
   * `raw` is one flat string with no timing in it. This is the timing, kept
   * beside the bytes it belongs to, so a replay can group deliveries the way
   * the programme produced them rather than the way a buffer happened to fill.
   */
  arrivals: ArrivalAt[];
  /** Total bytes fed to the emulator. */
  bytes: number;
  /** Raw output, kept so a trace can be replayed without re-running anything. */
  raw: string;
}

/**
 * A corpus programme.
 *
 * `emit` writes to a real stdout, so the same programme can be run through a
 * pty or captured and fed to the emulator directly.
 */
export interface Programme {
  id: string;
  category: 'basic' | 'cli' | 'complex';
  summary: string;
  cols?: number;
  rows?: number;
  /**
   * Write the output. Receives helpers so programmes stay short and readable,
   * and resolve when finished.
   */
  run(io: ProgrammeIo): Promise<void>;
  /**
   * Expected classifications, as byte ranges. `spans` lets a programme name
   * byte offsets it recorded itself, so ranges stay correct if the text grows.
   */
  expectations(marks: Record<string, number>): SegmentExpectation[];
}

/**
 * Pauses a programme puts between its own writes.
 *
 * These are not decoration. The classifier's verdict depends on where
 * deliveries begin (CLASSIFIER.md §9.3), so a pause is what makes two acts
 * two acts. Recorded with the bytes, a pause is the only signal a job
 * boundary can be recovered from — and a corpus whose pauses are all 15ms
 * long, or all absent, cannot distinguish a burst from a sequence at all.
 *
 * The values are what the thing being modelled actually does:
 *
 *  - a human acting — moving a cursor, pressing a key, stepping a pager —
 *    takes roughly a tenth of a second, not a millisecond;
 *  - a program animating on its own is faster than a human and steadier;
 *  - output *within* one act is deliberately tight, because it is one act.
 *    `complex.interleaved` depends on this: its log line and its status
 *    repaint are one update, and spacing them like interactions would make
 *    them two and falsify the programme.
 */

/** A human acting: a cursor move, a keystroke, a pager step, a TUI transition. */
export const INTERACTION_PAUSE_MS = 120;

/** A program animating by itself: a spinner frame, a progress tick, a dashboard refresh. */
export const FRAME_PAUSE_MS = 80;

/** Output within one act. Small on purpose — these are a single update. */
export const BURST_PAUSE_MS = 6;

export interface ProgrammeIo {
  out: NodeJS.WriteStream | { write(s: string): boolean };
  /** Record the current byte offset under `name`, for use in `expectations`. */
  mark(name: string): void;
  /** Current byte offset written so far. */
  offset(): number;
  /** Pause, so output arrives over time rather than as one burst. */
  wait(ms: number): Promise<void>;
  /** Read pending stdin, if the harness is driving this programme. */
  onInput(handler: (data: string) => void): void;
  /**
   * Ask the harness to resize the terminal.
   *
   * Emits a marker into the output and records where. A direct replay resizes at
   * that byte offset; a pty run is resized by the parent that owns the pty.
   * Either way a programme that needs the reflow to have happened before it
   * redraws should `wait` afterwards, because the pty path round-trips through
   * another process.
   */
  resize(cols: number, rows: number): void;
  cols: number;
  rows: number;
}

export type { Op };

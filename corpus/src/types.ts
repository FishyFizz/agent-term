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
  cols: number;
  rows: number;
}

export type { Op };

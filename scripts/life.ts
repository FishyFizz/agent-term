/**
 * Drive the lifelike subject through AgentTerm's own surface and print what
 * comes back.
 *
 * Through the surface -- the tools an agent has -- rather than through
 * `SessionHost` and the session's internals. The distinction is the point: a
 * harness written against the library exercises the library, and says nothing
 * about what an agent can do with the tools. So every byte of input here is a
 * named key or a line of text (`send_sequence`, `send_input`) and never an
 * escape sequence spelled out by hand, readiness is a pattern the subject
 * prints (`wait_for_output`) rather than a screen polled in a loop, and every
 * frame printed is one a tool returned -- the screen a wait already carries,
 * where a wait carried it.
 *
 * Not a unit test: this is the harness you point at the subject to watch how it
 * behaves, and the thing to run before concluding anything about whether an
 * agent can drive it.
 *
 * Run with: npx tsx scripts/life.ts [--seed 7] [--pick menu|chat|multiline] [--speed 4]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SessionHost } from '../src/host.js';
import { createServer } from '../src/mcp.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const seed = flag('seed') ?? '1';
  const speed = flag('speed') ?? '4';
  const pick = flag('pick');

  const host = new SessionHost();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  const client = new Client({ name: 'life-harness', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  /**
   * What every change report said, kept per state.
   *
   * A group and a read of the same state are the same answer twice rather than
   * two pieces of evidence, so the tally and the transcript are keyed by `seq`:
   * a state counted twice would make the numbers below a count of how often a
   * driver looked, which is not a fact about the subject. Only a result that
   * carries a change report counts as one -- a match and a timeout name a state
   * without reporting it, and claiming it from them would blank the report a
   * read of that same state is about to give.
   */
  const states = new Map<number, { text: string[]; segments: Array<{ kind?: string }> }>();
  const transcript: string[] = [];

  const note = (state: Record<string, unknown>): void => {
    const seq = typeof state.seq === 'number' ? state.seq : null;
    if (seq === null || states.has(seq)) return;
    if (!Array.isArray(state.text) && !Array.isArray(state.segments)) return;
    const text = Array.isArray(state.text) ? (state.text as string[]) : [];
    const segments = Array.isArray(state.segments)
      ? (state.segments as Array<{ kind?: string }>)
      : [];
    states.set(seq, { text, segments });
    transcript.push(...text);
  };

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    if (result.isError) {
      throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`);
    }
    const state = result.structuredContent ?? {};
    note(state);
    return state;
  };

  /** The rows a result carried, or a read when it carried none. */
  const screen = async (state?: Record<string, unknown>): Promise<string> => {
    const rows = state?.screen ?? (await call('read_screen', { sessionId })).screen;
    const lines = Array.isArray(rows) ? (rows as string[]) : [];
    return lines.join('\n').replace(/\n+$/, '');
  };

  const send = (text: string): Promise<Record<string, unknown>> =>
    call('send_input', { sessionId, text, submit: true });

  /** A key by name: the server encodes it from the mode the subject has set. */
  const key = (name: string): Promise<Record<string, unknown>> =>
    call('send_sequence', { sessionId, steps: [{ key: name }] });

  /**
   * Wait for the subject to say it is ready.
   *
   * The prompt is the whole readiness signal, and a pattern wait is the
   * surface's way of hearing it: it resolves on the row the subject wrote, with
   * no interval to guess at -- `idle` would answer "it went quiet", which is
   * what a subject thinking looks like too. `false` means the prompt did not
   * come back, and the caller says so rather than guessing what the silence was.
   */
  const ready = async (): Promise<boolean> => {
    const waited = await call('wait_for_output', {
      sessionId,
      pattern: '^\\$$',
      timeoutMs: 30_000,
    });
    return waited.reason === 'matched';
  };

  const opened = await call('open_session', {
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      'fixtures/life/index.ts',
      '--seed',
      seed,
      '--speed',
      speed,
      ...(pick === undefined ? [] : ['--pick', pick]),
    ],
    cols: 80,
    rows: 24,
  });
  const sessionId = String(opened.sessionId);

  console.log(`subject: seed=${seed} speed=${speed} pick=${pick ?? '(random)'}`);

  try {
    if (!(await ready())) {
      console.log('\n--- the subject never became ready ---\n' + (await screen()));
      return;
    }
    console.log('\n--- ready ---\n' + (await screen()));

    if (pick === 'menu') {
      await send('go');
      await call('wait_for_output', { sessionId, pattern: 'Select an item', timeoutMs: 30_000 });
      console.log('\n--- menu ---\n' + (await screen()));

      await key('down');
      await key('enter');
      await delay(1_500);
      console.log('\n--- window ---\n' + (await screen()));

      await key('enter');
      await delay(1_500);

      // Walk the highlight onto "back" by reading what came back rather than by
      // counting presses: how many items there are is the subject's business,
      // and a driver that hardcodes it is one that breaks when the subject
      // changes. A read is a tool call like any other, and it moves the waits'
      // baseline with it, so a wait after one asks about what happened after it.
      for (let i = 0; i < 14; i++) {
        const frame = await screen();
        if (frame.split('\n').some((line) => line.includes('●') && line.includes('back'))) break;
        await key('down');
        await delay(120);
      }
      await key('enter');
      await delay(1_000);
      console.log('\n--- back at the shell ---\n' + (await screen()));
    } else if (pick === 'chat') {
      await send('go');
      await call('wait_for_output', {
        sessionId,
        pattern: "type 'quit' to exit",
        timeoutMs: 30_000,
      });
      console.log('\n--- chat ---\n' + (await screen()));

      await send('hello there');
      await call('wait_for_output', {
        sessionId,
        pattern: 'Got it - hello there\\.',
        timeoutMs: 30_000,
      });
      console.log('\n--- one exchange ---\n' + (await screen()));

      await send('quit');
      await ready();
      console.log('\n--- back at the shell ---\n' + (await screen()));
    } else {
      let answered = true;
      for (const line of ['one', 'two']) {
        await send(line);
        answered = await ready();
        // A random subject can answer with a menu or a chat frame instead, and
        // the prompt is then not coming back until that mode is left. That is a
        // fact about the run rather than a failure of the harness, so it is
        // printed as one -- and `--pick menu` / `--pick chat` are how the other
        // two are asked for.
        if (!answered) break;
      }
      console.log(
        (answered ? '\n--- after two lines ---\n' : '\n--- the subject went into a mode ---\n') +
          (await screen()),
      );
    }

    const classified = { writing: 0, drawing: 0 };
    for (const state of states.values()) {
      for (const segment of state.segments) {
        if (segment.kind === 'writing') classified.writing++;
        else if (segment.kind === 'drawing') classified.drawing++;
      }
    }
    console.log(
      `\n--- classified: ${classified.writing} writing segment(s), ` +
        `${classified.drawing} drawing segment(s) ---`,
    );
    console.log('\n--- transcript ---\n' + transcript.join('\n'));
  } finally {
    // A run can end before the harness does -- `exit` typed at the subject, or a
    // subject that died -- and that is worth printing rather than throwing on
    // the way out.
    try {
      await send('exit');
      await delay(400);
    } catch (cause) {
      console.log(
        `\n(the session was already gone: ${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    await call('close_session', { sessionId });
    await client.close();
    await server.close();
    host.disposeAll();
  }
}

void main();

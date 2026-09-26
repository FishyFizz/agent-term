/**
 * The MCP surface, driven through a real client rather than by calling the
 * handlers directly.
 *
 * That distinction is the point: a handler called in-process proves nothing
 * about the schema a client sees, or about what survives being serialised and
 * answered. So this connects a Client and a Server over a linked in-memory
 * transport and exercises the loop the way an agent would — open, type, read,
 * close — against a real pty running a real shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { SessionHost } from '../src/host.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connected() {
  const host = new SessionHost();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, host, close: async () => { await client.close(); await server.close(); } };
}

type ToolResult = Record<string, unknown> & { content?: Array<{ text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

test('the surface exposes the core loop', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'close_session',
    'history_read',
    'open_session',
    'read_screen',
    'send_input',
    'send_sequence',
    'wait_for_idle',
    'wait_for_job',
    'wait_for_output',
  ]);
  for (const tool of tools.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} says what it does`);
    assert.ok(tool.inputSchema, `${tool.name} declares its input`);
  }
});

test('an agent can open a shell, run a command, and read the result', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  assert.ok(sessionId, 'a session id came back');

  await call(client, 'send_input', { sessionId, text: 'echo AGENTTERM-MCP', submit: true });

  // Real output over a real pty, so it arrives when it arrives.
  let screen = '';
  for (let i = 0; i < 200 && !screen.includes('AGENTTERM-MCP'); i++) {
    await delay(50);
    const read = await call(client, 'read_screen', { sessionId });
    screen = (read.content?.[0]?.text ?? '') + JSON.stringify(read.structuredContent ?? {});
  }
  assert.ok(screen.includes('AGENTTERM-MCP'), `the echo came back, got: ${screen.slice(0, 300)}`);

  const read = await call(client, 'read_screen', { sessionId });
  const payload = read.structuredContent as {
    screen: string[];
    segments: Array<{ kind: string }>;
    collapsed: unknown;
    io: { bytesRead: number };
  };
  assert.ok(payload.screen.length > 0, 'the screen came back as rows');
  assert.ok(payload.segments.length > 0, 'with what changed on it');
  assert.equal(payload.segments[0]!.kind, 'writing', 'appended text is reported as writing');
  assert.ok(payload.io.bytesRead > 0, 'and a byte watermark to distinguish quiet from unread');
});

test('a read after a wait is the new state, not the one the send interrupted', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  await call(client, 'send_input', { sessionId, text: 'echo WAITED-WELL', submit: true });

  // No polling loop anywhere in this test: the wait is what finds the output.
  const waited = await call(client, 'wait_for_idle', { sessionId, idleMs: 300, timeoutMs: 15000 });
  const result = waited.structuredContent as {
    reason: string;
    waitedMs: number;
    state: { running: boolean; idleMs: number | null; drained: boolean | null };
  };
  assert.ok(
    result.reason === 'idle' || result.reason === 'exited',
    `the wait ended well, got: ${result.reason}`,
  );
  assert.ok(result.waitedMs >= 0, 'and reports how long it took');
  assert.equal(result.state.drained, true, 'drained: what it produced has been read through');

  const read = await call(client, 'read_screen', { sessionId });
  const screen = (read.content?.[0]?.text ?? '') + JSON.stringify(read.structuredContent ?? {});
  assert.ok(screen.includes('WAITED-WELL'), `the output is there, got: ${screen.slice(0, 300)}`);
});

test('a read reports the session state as facts, with no verdict on it', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  await call(client, 'wait_for_idle', { sessionId, idleMs: 200, timeoutMs: 15000 });

  const read = await call(client, 'read_screen', { sessionId });
  const state = (read.structuredContent as { state: Record<string, unknown> }).state;
  assert.deepEqual(
    Object.keys(state).sort(),
    ['bytesPending', 'drained', 'exit', 'idleMs', 'running'],
    'a caller is given measurements and can find no field that decided for it',
  );
  assert.equal(state.running, true, 'running');
  assert.equal(state.exit, null, 'and no exit');
});

test('a wait that cannot be satisfied says so, rather than hanging', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  // A minute of quiet asked for, 50ms allowed: unreachable, and reported.
  const waited = await call(client, 'wait_for_idle', { sessionId, idleMs: 60000, timeoutMs: 50 });
  const result = waited.structuredContent as { reason: string; waitedMs: number };
  assert.equal(result.reason, 'timeout', 'gave up rather than hanging');
  assert.ok(result.waitedMs <= 50 + 100, `and did not overrun by much (${result.waitedMs}ms)`);
});

test('an unknown session is a typed error, not a stack trace', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const result = await call(client, 'read_screen', { sessionId: 'nope' });
  assert.equal(result.isError, true, 'reported as an error');
  const error = (result.structuredContent as { error: { code: string } }).error;
  assert.equal(error.code, 'no_session', 'with a code a caller can branch on');
});

test('a wait for output resolves on a pattern and says what matched', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  // A subject with a prompt on the current row and a distinct answer per
  // input, so the wait can tell the prompt from the echo of what was typed.
  const probe =
    "let n=0;process.stdout.write('PROMPT> ');" +
    "process.stdin.on('data',()=>{n++;process.stdout.write('GOT-'+n+'\\r\\n');" +
    "setTimeout(()=>process.stdout.write('PROMPT> '),150)});";
  const opened = await call(client, 'open_session', {
    command: process.execPath,
    args: ['-e', probe],
  });
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  // Nothing has been typed, so everything on the screen is new to this caller
  // and the prompt that is already there matches.
  const first = await call(client, 'wait_for_output', {
    sessionId,
    pattern: '^PROMPT>$',
    timeoutMs: 10000,
  });
  assert.equal((first.structuredContent as { reason: string }).reason, 'matched');

  await call(client, 'send_input', { sessionId, text: 'hello', submit: true });

  const waited = await call(client, 'wait_for_output', {
    sessionId,
    pattern: '^PROMPT>$',
    timeoutMs: 10000,
  });
  const payload = waited.structuredContent as {
    reason: string;
    match: { surface: string; text: string; row: number | null; atByte: number } | null;
    sinceByte: number;
    waitedMs: number;
  };
  assert.equal(payload.reason, 'matched', 'the prompt came back');
  assert.ok(payload.match, 'with what matched');
  assert.equal(payload.match!.surface, 'screen');
  assert.equal(payload.match!.text, 'PROMPT>', 'the bare prompt, not the echoed line');
  assert.ok(payload.match!.atByte > payload.sinceByte, 'and it was produced after the baseline');

  // The text that the wait stood on is the caller's to read next, and a read
  // taken now is one that does not need guessing about.
  const read = await call(client, 'read_screen', { sessionId });
  const screen = (read.content?.[0]?.text ?? '') + JSON.stringify(read.structuredContent ?? {});
  assert.ok(screen.includes('GOT-1'), `the answer is on the screen, got: ${screen.slice(0, 300)}`);
});

test('a pattern that will not compile is a typed error', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const result = await call(client, 'wait_for_output', { sessionId, pattern: '(', timeoutMs: 100 });
  assert.equal(result.isError, true, 'reported as an error');
  const error = (result.structuredContent as { error: { code: string; message: string } }).error;
  assert.equal(error.code, 'bad_pattern', 'with a code a caller can branch on');
  assert.ok(error.message.includes('('), 'and the pattern it could not use');
});

test('a wait for output on an unknown session is a typed error', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const result = await call(client, 'wait_for_output', {
    sessionId: 'nope',
    pattern: 'x',
    timeoutMs: 100,
  });
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    'no_session',
  );
});

test('closing ends the session and the tool says so', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const closed = await call(client, 'close_session', { sessionId });
  assert.equal((closed.structuredContent as { closed: boolean }).closed, true);

  const after = await call(client, 'read_screen', { sessionId });
  assert.equal(after.isError, true, 'the session is gone afterwards');
});

/**
 * A subject that reports the exact bytes it receives, so a claim about what a
 * key encoded to can be checked against the program rather than against our own
 * return value. `setRawMode` is a measured requirement: without it the child is
 * line-buffered and receives nothing until a line ending arrives.
 *
 * The escape sequences are written `\x1b` in the child's *source*, which the
 * child then parses as ESC -- see the same note in `jobs-live.test.ts`.
 */
function byteReporter(withDecckm: boolean): string {
  return (
    'try{process.stdin.setRawMode(true)}catch(e){};' +
    (withDecckm ? "process.stdout.write('\\x1b[?1h');" : '') +
    "process.stdout.write('PROMPT> ');" +
    "process.stdin.on('data',b=>{process.stdout.write('\\r\\nGOT '+" +
    "Buffer.from(b).toString('hex')+'\\r\\nPROMPT> ')});"
  );
}

/** The bytes the subject reported receiving, in the order it reported them. */
function reported(lines: readonly string[]): string {
  return lines
    .map((line) => /^GOT ([0-9a-f]+)$/.exec(line.trimEnd())?.[1])
    .filter((hex): hex is string => hex !== undefined)
    .join('');
}

test('a key is encoded for the mode the program set, not from a fixed table', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  async function drive(withDecckm: boolean) {
    const opened = await call(client, 'open_session', {
      command: process.execPath,
      args: ['-e', byteReporter(withDecckm)],
    });
    const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

    // The prompt is written *after* the mode bytes, so a match is evidence the
    // mode has been parsed -- which is what `modes` reports.
    const ready = await call(client, 'wait_for_output', {
      sessionId,
      pattern: '^PROMPT>$',
      timeoutMs: 10000,
    });
    assert.equal((ready.structuredContent as { reason: string }).reason, 'matched', 'ready');

    const sent = await call(client, 'send_sequence', { sessionId, steps: [{ key: 'down' }] });
    const result = sent.structuredContent as {
      written: string;
      bytesWritten: number;
      modes: { applicationCursorKeys: boolean } | null;
    };

    await call(client, 'wait_for_output', {
      sessionId,
      pattern: '^GOT [0-9a-f]+$',
      timeoutMs: 10000,
    });
    const read = await call(client, 'read_screen', { sessionId });
    const lines = (read.structuredContent as { screen: string[] }).screen;
    return { result, seen: reported(lines) };
  }

  // DECCKM set: the program asked for application cursor keys, so Down is SS3.
  const application = await drive(true);
  assert.equal(application.result.modes?.applicationCursorKeys, true, 'the mode was read');
  assert.equal(application.result.written, '\\x1bOB', 'and reported as what was written');
  assert.equal(application.result.bytesWritten, 3, 'three bytes, not three characters');
  assert.equal(application.seen, '1b4f42', 'the program received SS3 B');

  // The negative control. Without it the assertion above is satisfied by any
  // hardcoded byte string and proves nothing about the mode being consulted.
  const plain = await drive(false);
  assert.equal(plain.result.modes?.applicationCursorKeys, false, 'the mode was read, and was off');
  assert.equal(plain.result.written, '\\x1b[B', 'so Down is CSI B');
  assert.equal(plain.seen, '1b5b42', 'and that is what the program received');
});

test('a batch is one write, and says what each step became', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {
    command: process.execPath,
    args: ['-e', byteReporter(false)],
  });
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  await call(client, 'wait_for_output', { sessionId, pattern: '^PROMPT>$', timeoutMs: 10000 });

  // "type this, then press Enter" -- the case the batched form exists for.
  const sent = await call(client, 'send_sequence', {
    sessionId,
    steps: [{ text: 'go' }, { key: 'down' }, { key: 'enter' }],
  });
  assert.notEqual(sent.isError, true, 'the batch is accepted');

  const result = sent.structuredContent as {
    written: string;
    bytesWritten: number;
    steps: Array<{ kind: string; key?: string; written: string }>;
    modes: { applicationCursorKeys: boolean } | null;
  };
  assert.equal(result.written, 'go\\x1b[B\\x0d', 'the batch as one string, in order');
  assert.equal(result.bytesWritten, 6, 'and counted in bytes');
  assert.deepEqual(
    result.steps.map((step) => [step.kind, step.key ?? null, step.written]),
    [['text', null, 'go'], ['key', 'down', '\\x1b[B'], ['key', 'enter', '\\x0d']],
    'each step reports its kind, its canonical key name and its bytes',
  );
  assert.equal(result.modes?.applicationCursorKeys, false, 'an arrow consulted the mode');

  await call(client, 'wait_for_output', { sessionId, pattern: '^GOT [0-9a-f]+$', timeoutMs: 10000 });
  const read = await call(client, 'read_screen', { sessionId });
  const lines = (read.structuredContent as { screen: string[] }).screen;
  // The concatenation, not a count of reports: that a whole batch arrives in a
  // single read is the terminal's chunking, not something this server promises.
  assert.equal(reported(lines), '676f1b5b420d', 'the program received the batch, in order');
});

test('a batch that cannot be composed is a typed error, not a silent no-op', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const cases: Array<[string, unknown[], RegExp]> = [
    ['an unknown key', [{ key: 'dwn' }], /did you mean "down"/],
    ['two fields in one step', [{ key: 'down', byte: 27 }], /found key and byte/],
    ['a field it does not know', [{ keys: 'down' }], /unknown field "keys"/],
    ['no fields at all', [{}], /found none/],
  ];

  for (const [label, steps, expected] of cases) {
    const result = await call(client, 'send_sequence', { sessionId, steps });
    assert.equal(result.isError, true, `${label} is refused`);
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'bad_input', `${label} carries a code a caller can branch on`);
    assert.match(error.message, expected, `${label} says what to fix`);
  }

  const empty = await call(client, 'send_sequence', { sessionId, steps: [] });
  assert.equal(empty.isError, true, 'an empty batch is refused');
  assert.match(
    (empty.structuredContent as { error: { message: string } }).error.message,
    /nothing would be written/,
    'and says why: an empty write still moves the watermark a wait measures against',
  );

  // A refused batch writes nothing, so the session is still usable.
  const after = await call(client, 'send_sequence', { sessionId, steps: [{ key: 'enter' }] });
  assert.notEqual(after.isError, true, 'the session was not disturbed by the refusals');
});

test('send_input reports the bytes it wrote, including the newline it appended', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const shape = (result: ToolResult) => ({
    bytesWritten: (result.structuredContent as { bytesWritten: number }).bytesWritten,
    written: (result.structuredContent as { written: string }).written,
    submitted: (result.structuredContent as { submitted: boolean }).submitted,
  });

  const typed = await call(client, 'send_input', { sessionId, text: 'hi' });
  assert.deepEqual(
    shape(typed),
    { bytesWritten: 2, written: 'hi', submitted: false },
    'what was typed, and nothing appended',
  );

  // The count includes the line ending, so it counts what was actually written
  // rather than only the caller's payload.
  const submitted = await call(client, 'send_input', { sessionId, text: 'hi', submit: true });
  assert.deepEqual(
    shape(submitted),
    { bytesWritten: 4, written: 'hi\\x0d\\x0a', submitted: true },
    'what was typed, plus the line ending that was actually sent',
  );
});

/**
 * The loop the feedback left open, driven through a real client.
 *
 * `read_screen` reports `collapsed.intermediates` -- states that existed and
 * were not shown -- and until now nothing on the surface could reach them.
 * The whole point of one history tool is that the same call that pages also
 * plays those back, so this follows a real collapsed job into its frames.
 */
test('a collapsed job\'s swallowed frames are reachable from the surface', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  // Enough output at once that the pty delivers it in more than one piece and
  // the job swallows some -- the shape `intermediates` exists to report.
  await call(client, 'send_input', {
    sessionId,
    text: 'for i in 1 2 3 4 5 6 7 8; do printf "row-%s\\n" "$i"; done',
    submit: true,
  });
  await call(client, 'wait_for_output', { sessionId, pattern: 'row-8', timeoutMs: 5000 });

  const read = await call(client, 'read_screen', { sessionId });
  const collapsed = (read.structuredContent as { collapsed?: { chunks: number; intermediates: boolean; rawFrom: number; rawTo: number } })
    .collapsed;

  // The timeline is addressable whether or not this particular run collapsed:
  // what is being proven is that the surface can be driven to any point.
  const span = collapsed?.intermediates
    ? { from: { seq: collapsed.rawFrom }, to: { seq: collapsed.rawTo } }
    : { from: { seq: 1 }, to: { seq: 2 } };

  const played = await call(client, 'history_read', { sessionId, ...span });
  const body = played.structuredContent as {
    span: boolean;
    truncated: boolean;
    records?: Array<{ seq: number; screen: string[]; text: string[] }>;
  };

  assert.equal(body.span, true, 'a `to` reads a span, not a page');
  assert.ok(body.records && body.records.length > 0, 'the span came back with records');
  for (const record of body.records!) {
    assert.ok(record.screen.length > 0, 'each frame carries the screen it produced');
  }
  assert.deepEqual(
    body.records!.map((r) => r.seq),
    [...body.records!.map((r) => r.seq)].sort((a, b) => a - b),
    'in the order they happened',
  );
});

test('history survives the session being closed, and is still addressable', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  await call(client, 'send_input', { sessionId, text: 'echo SURVIVES-CLOSE', submit: true });
  await call(client, 'wait_for_output', { sessionId, pattern: 'SURVIVES-CLOSE', timeoutMs: 5000 });

  const paged = (await call(client, 'history_read', { sessionId, level: 'text' })).structuredContent as {
    lines: string[];
    next: string | null;
    truncated: boolean;
    epoch: { cols: number; rows: number };
  };
  assert.ok(
    paged.lines.some((l) => l.includes('SURVIVES-CLOSE')),
    'the output is in the timeline',
  );
  // `null` here means the read reached the end of the timeline, which is what
  // a short session does: `next` is somewhere to resume, and there is nothing
  // to resume to. Asserting a string would be asserting the session produced
  // more than one page of output, which is not what this is about.
  assert.equal(paged.next, null, 'nothing left to resume to');
  assert.equal(paged.truncated, false, 'the limit did not stop the read');
  assert.ok(paged.epoch.cols > 0, 'and it says what size it was produced at');

  await call(client, 'close_session', { sessionId });

  const after = (await call(client, 'history_read', { sessionId, level: 'text' })).structuredContent as {
    lines: string[];
  };
  assert.ok(
    after.lines.some((l) => l.includes('SURVIVES-CLOSE')),
    'closing is not forgetting (L0.3)',
  );
});

test('a bad address is a typed error a caller can branch on', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const bad = await call(client, 'history_read', { sessionId, from: 'not-a-token' });
  assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'bad_input');

  const none = await call(client, 'history_read', { sessionId: 'no-such-session' });
  assert.equal((none.structuredContent as { error: { code: string } }).error.code, 'no_session');
});

test('a job wait returns the act whole, and its swallowed states are reachable', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  await call(client, 'send_input', { sessionId, text: 'echo JOB-ONE', submit: true });
  const waited = await call(client, 'wait_for_job', { sessionId, timeoutMs: 20000 });
  const job = waited.structuredContent as {
    reason: string;
    seq: number;
    job: number | null;
    collapsed: { chunks: number; rawFrom: number; reason: string } | null;
    screen: string[] | null;
  };

  assert.equal(job.reason, 'job', 'the wait ended on a job');
  assert.ok(job.screen, 'and carried the screen, so no second read is needed');
  assert.ok(job.seq > 0, 'ending at a state');

  // The number it reports is one the timeline addresses, so a job that
  // swallowed states hands back a span that can be played.
  if (job.collapsed && job.collapsed.chunks > 1) {
    const played = (await call(client, 'history_read', {
      sessionId,
      from: { seq: job.collapsed.rawFrom },
      to: { seq: job.seq },
      screen: true,
    })).structuredContent as { records: Array<{ seq: number; screen?: { lines: string[] } }> };
    assert.equal(
      played.records.length,
      job.collapsed.chunks,
      'every swallowed state comes back',
    );
    for (const record of played.records) {
      assert.ok(record.screen, 'with the screen it had');
    }
  }
});

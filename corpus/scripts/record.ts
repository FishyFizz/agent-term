/**
 * Records every corpus programme and writes traces to `traces/`.
 *
 * Usage:
 *   npx tsx scripts/record.ts                 # all programmes, direct feed
 *   npx tsx scripts/record.ts --feed pty      # all programmes, through a real pty
 *   npx tsx scripts/record.ts --only cli.     # filter by id prefix
 *   npx tsx scripts/record.ts --print         # dump a summary per trace
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allProgrammes } from '../programmes/index.js';
import { runDirect, runPty } from '../src/runner.js';
import type { Trace } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'traces');

function parseArgs(argv: string[]): {
  feed: 'direct' | 'pty' | 'both';
  only: string;
  print: boolean;
} {
  let feed: 'direct' | 'pty' | 'both' = 'direct';
  let only = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--feed' && next) {
      if (next === 'direct' || next === 'pty' || next === 'both') feed = next;
      i++;
    } else if (arg === '--only' && next) {
      only = next;
      i++;
    }
  }
  return { feed, only, print: argv.includes('--print') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const selected = allProgrammes.filter((p) => p.id.startsWith(args.only));
  if (selected.length === 0) {
    console.error(`no programme matches --only ${JSON.stringify(args.only)}`);
    process.exit(2);
  }

  const feeds: Array<'direct' | 'pty'> = args.feed === 'both' ? ['direct', 'pty'] : [args.feed];
  let failures = 0;

  for (const feed of feeds) {
    console.log(`\n=== feed: ${feed} ===`);
    for (const programme of selected) {
      process.stdout.write(`  ${programme.id.padEnd(34)} `);
      try {
        const { trace } = feed === 'direct' ? await runDirect(programme) : await runPty(programme);
        const file = join(outDir, `${programme.id}.${feed}.json`);
        writeFileSync(file, JSON.stringify(trace, null, 2), 'utf8');
        const counts = countOps(trace);
        console.log(
          `ok  bytes=${trace.bytes} ops=${trace.ops.length} frames=${trace.frames.length} ` +
            `csi=${counts.csi} esc=${counts.esc} ev=${counts.event}`,
        );
        if (args.print) printTrace(trace);
        if (trace.bytes === 0) {
          console.log(`    WARN: no bytes recorded`);
          failures++;
        }
      } catch (err) {
        failures++;
        console.log(`FAIL ${String(err)}`);
      }
    }
  }

  console.log(failures === 0 ? '\nrecorded all traces' : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

function countOps(trace: Trace): Record<string, number> {
  const counts: Record<string, number> = { csi: 0, esc: 0, event: 0 };
  for (const op of trace.ops) counts[op.source] = (counts[op.source] ?? 0) + 1;
  return counts;
}

function printTrace(trace: Trace): void {
  console.log(`    summary: ${trace.summary}`);
  console.log(`    ops: ${trace.ops.slice(0, 14).map((o) => o.name).join(' ')}`);
  if (trace.ops.length > 14) console.log(`         ... +${trace.ops.length - 14} more`);
  for (const e of trace.expectations) {
    console.log(`    expect [${e.from}..${e.to}] ${e.kind}`);
  }
  const last = trace.frames[trace.frames.length - 1];
  if (last) {
    console.log(`    final screen (${last.buffer}):`);
    for (const line of last.lines) console.log(`      |${line}|`);
  }
}

main().catch((err) => {
  console.error('record failed:', err);
  process.exit(1);
});

/** Scratch: are op byte offsets ever distinct within one delivery? */
import { ScreenModel } from '../src/screen.js';

const s = new ScreenModel(20, 5);
const from = s.ops.bytesFed;
await s.feed('a\r\n\x1b[5;1H[##]\x1b[Kb');
const ops = [...s.ops.recorded];
console.log('fromByte', from, 'toByte', s.ops.bytesFed);
console.log('ops:', ops.map((o) => `${o.name}@${o.byteOffset}`).join(' '));

// And across a session: does any delivery ever yield >1 distinct offset?
const s2 = new ScreenModel(20, 5);
let deliveriesWithDistinct = 0;
let deliveriesWithOps = 0;
for (const chunk of ['a\r\n', '\x1b[1;1Haa\x1b[K\x1b[2;1Hbb\x1b[K', 'x', '\x1b[2J\x1b[H']) {
  const f = s2.ops.bytesFed;
  await s2.feed(chunk);
  const o = s2.ops.recorded.filter((x) => x.byteOffset >= f);
  s2.ops.clear();
  if (o.length === 0) continue;
  deliveriesWithOps++;
  const distinct = new Set(o.map((x) => x.byteOffset)).size;
  const atEnd = o.every((x) => x.byteOffset === s2.ops.bytesFed);
  console.log(`chunk ${JSON.stringify(chunk)}: ops=${o.map((x) => x.name + '@' + x.byteOffset).join(',')} distinct=${distinct} allAtDeliveryEnd=${atEnd}`);
  if (distinct > 1) deliveriesWithDistinct++;
}
console.log(`deliveries with ops=${deliveriesWithOps}, with distinct offsets=${deliveriesWithDistinct}`);

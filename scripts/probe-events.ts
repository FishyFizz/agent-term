import { ScreenModel } from '../src/screen.js';
const s = new ScreenModel(20, 5);
await s.feed('a\r\n');
await s.feed('\x1b[?1049h');
await s.feed('\x1b[?1049l');
for (const o of s.ops.recorded) console.log(`${o.source}:${o.name} @${o.byteOffset} alt=${o.altScreen} params=[${o.params}]`);

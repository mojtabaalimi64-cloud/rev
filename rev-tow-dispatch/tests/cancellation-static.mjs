import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const s=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
assert.match(s,/if \(!r\.cancelToken \|\| !b\.cancelToken \|\| b\.cancelToken !== r\.cancelToken\)/);
assert.match(s,/if \(!r \|\| !r\.cancelToken \|\| !cancelToken \|\| cancelToken !== r\.cancelToken\)/);
assert.match(s,/await dispatchToNext\(env, r\)/);
assert.match(s,/if \(r\.status === "انجام شد"\)/);
assert.match(s,/if \(r\.status !== "راننده در راه"\)/);
console.log('Static cancellation invariants PASS; runtime and concurrency not covered.');

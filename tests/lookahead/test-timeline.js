// Node test for PcmTimeline: out-of-order writes, coverage, readyAhead, eviction.
const assert = require('assert');
const PcmTimeline = require(require('path').join(__dirname, '../../lookahead/pcm-timeline.js'));
const SR = 16000;
const tl = new PcmTimeline({ keepBehind: 5, keepAhead: 60 });
const chunk = (t, n = 320, v = 1) => ({ time: t, samples: new Float32Array(n).fill(v) });

// 0-10 s in 20 ms chunks, written out of order (second half first, like a seek back).
// 20 ms chunks by integer index (i * 0.02 s), so there's no float drift.
const span = (from, to, v) => { for (let i = Math.round(from * 50); i < Math.round(to * 50); i++) tl.add(chunk(i / 50, 320, v)); };
span(5, 10, 1);
span(0, 5, 1);
assert(Math.abs(tl.readyAhead(0) - 10) < 0.02, 'readyAhead(0) should be ~10 s, got ' + tl.readyAhead(0));
assert(Math.abs(tl.readyAhead(7.5) - 2.5) < 0.02);

// A hole at 20-21 s with audio either side.
span(15, 20, 0.5);
span(21, 25, 0.5);
assert(Math.abs(tl.readyAhead(15) - 5) < 0.02, 'stops at the hole');
assert.strictEqual(tl.readyAhead(12), 0, 'nothing decoded at 12 s');
const r = tl.read(19.5, 21.5);
assert(Math.abs(r.covered - 0.5) < 0.01, 'half of 19.5-21.5 is decoded');
assert.strictEqual(r.samples[0], 0.5);
assert.strictEqual(r.samples[Math.round(0.75 * SR)], 0, 'hole reads as silence');

// A chunk straddling a second boundary keeps exact sample positions.
tl.add({ time: 30.99, samples: Float32Array.from({ length: 480 }, (_, i) => i) });
const s = tl.read(30.99, 31.02).samples;
assert.strictEqual(s[0], 0); assert.strictEqual(s[159], 159); assert.strictEqual(s[160], 160); assert.strictEqual(s[479], 479);

// Eviction keeps [playhead-5, playhead+60].
tl.evict(20);
assert.strictEqual(tl.readyAhead(0), 0, 'audio before 15 s evicted');
assert(tl.readyAhead(15) > 4.9, 'recent audio kept');
console.log('timeline tests passed');

// Node test: LookaheadTranscriber + WordTimeline with a fake decoder and a fake
// Whisper. Words "w0, w1, ..." exist every 0.5 s of media; the fake Whisper
// reports the ones inside the audio it's given, with ±40 ms jitter, so
// overlapping windows disagree slightly like the real thing.
const assert = require('assert');
const path = require('path');
const PcmTimeline = require(path.join(__dirname, '../../lookahead/pcm-timeline.js'));
const WordTimeline = require(path.join(__dirname, '../../lookahead/word-timeline.js'));
const LookaheadTranscriber = require(path.join(__dirname, '../../lookahead/lookahead-transcriber.js'));

const SR = 16000, DURATION = 120;
const timeline = new PcmTimeline({ keepAhead: 600 });
const words = new WordTimeline();
let clock = 0; // simulated media playhead
let decodedTo = 0; // simulated decoder progress (stays 20 s ahead)
let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

const fakeWhisper = async (samples, offset) => {
  await new Promise((r) => setImmediate(r));
  const len = samples.length / SR, out = [];
  for (let k = Math.ceil(offset / 0.5); k * 0.5 < offset + len - 0.25; k++) {
    const jitter = (rnd() - 0.5) * 0.08;
    out.push({ text: ' w' + k, start: k * 0.5 + jitter, end: k * 0.5 + 0.3 + jitter });
  }
  return { words: out };
};

const lt = new LookaheadTranscriber({ timeline, words, transcribe: fakeWhisper, playhead: () => clock, duration: () => DURATION, idleMs: 0 });
let minAhead = Infinity, minAt = null;
(async () => {
  lt.start();
  // Advance media time in 100 ms steps; decode ahead in 1 s chunks of "speech".
  for (let step = 0; step <= DURATION * 10; step++) {
    clock = step / 10;
    if (step === 600) clock = 90; // seek forward at 60 s
    if (step > 600) clock = 90 + (step - 600) / 10;
    if (clock >= DURATION) break;
    while (decodedTo < Math.min(DURATION, clock + 20)) {
      timeline.add({ time: decodedTo, samples: new Float32Array(SR).fill(0.1) });
      decodedTo += 1;
    }
    if (step === 600) decodedTo = 90; // after the seek, decoding restarts at 90 s
    for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 0)); // let the scheduler run
    // "Ahead" can't exceed what's left of the video, so count min(5 s, time left) as enough.
    if (clock > 3 && (step < 600 || step > 640)) { const a = words.aheadOf(clock) + (5 - Math.min(5, DURATION - clock)); if (a < minAhead) { minAhead = a; minAt = clock; } }
  }
  lt.stop();

  // Every word in the played ranges [0, 60) and [90, 120) appears exactly once.
  const expect = (k) => (k * 0.5 < 60 || (k * 0.5 >= 90 && k * 0.5 < DURATION - 0.5));
  const counts = new Map();
  for (const w of words.words) counts.set(w.text.trim(), (counts.get(w.text.trim()) || 0) + 1);
  const missing = [], dupes = [];
  for (let k = 0; k * 0.5 < DURATION; k++) {
    const c = counts.get('w' + k) || 0;
    if (expect(k) && c === 0) missing.push(k);
    if (c > 1) dupes.push(k);
  }
  console.log({ windows: lt.stats.windows, minAheadAfterWarmup: +minAhead.toFixed(2), minAt, covered: words.covered.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), missing: missing.length, duplicates: dupes.length });
  assert.strictEqual(missing.length, 0, 'missing words: ' + missing.slice(0, 10));
  assert.strictEqual(dupes.length, 0, 'duplicated words: ' + dupes.slice(0, 10));
  assert(minAhead >= 5, 'transcript fell behind: ' + minAhead);
  console.log('lookahead transcriber tests passed');
})();

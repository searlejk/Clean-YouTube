// Node test for TranscriptCache with an in-memory stand-in for chrome.storage.local.
const assert = require('assert');
const path = require('path');
const WordTimeline = require(path.join(__dirname, '../../lookahead/word-timeline.js'));
const TranscriptCache = require(path.join(__dirname, '../../lookahead/transcript-cache.js'));

function memoryStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { return Object.fromEntries([k].flat().filter((x) => m.has(x)).map((x) => [x, JSON.parse(JSON.stringify(m.get(x)))])); },
    async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, JSON.parse(JSON.stringify(v))); },
    async remove(ks) { for (const k of [ks].flat()) m.delete(k); },
  };
}

(async () => {
  const storage = memoryStorage();
  // A first viewing: two transcribed stretches with a gap (the viewer skipped).
  const first = new WordTimeline();
  first.addWindow(0, 10, [{ text: ' hello', start: 1.2, end: 1.5 }, { text: ' shit', start: 9.9, end: 10.2 }]);
  first.addWindow(10, 20, [{ text: ' world', start: 12, end: 12.4 }]);
  first.addWindow(60, 70, [{ text: ' damn', start: 65.5, end: 65.8 }]);
  const cache = new TranscriptCache({ storage, maxBytes: 1e6 });
  await cache.init();
  await cache.save('abc123:tiny.en', first);

  // A later visit: a fresh cache object (new page) loads it back.
  const cache2 = new TranscriptCache({ storage, maxBytes: 1e6 });
  await cache2.init();
  assert(cache2.has('abc123:tiny.en'), 'index survives');
  assert(!cache2.has('abc123:base.en'), 'other model is a different entry');
  const second = new WordTimeline();
  assert(await cache2.load('abc123:tiny.en', second));
  assert.deepStrictEqual(second.words.map((w) => w.text.trim()), ['hello', 'shit', 'world', 'damn']);
  assert.strictEqual(second.coveredUntil(0), 20, 'stretch 0-20 restored');
  assert.strictEqual(second.coveredUntil(15), 20);
  assert.strictEqual(second.coveredUntil(30), null, 'gap stays untranscribed');
  assert.strictEqual(second.coveredUntil(61), 70);
  assert(Math.abs(second.words[1].start - 9.9) < 0.001, 'timestamps kept to the millisecond');

  // Loading doesn't clobber words already transcribed in the current session.
  const live = new WordTimeline();
  live.addWindow(60, 70, [{ text: ' darn', start: 65.5, end: 65.8 }]);
  await cache2.load('abc123:tiny.en', live);
  assert.deepStrictEqual(live.between(60, 70).map((w) => w.text.trim()), ['darn']);
  assert.strictEqual(live.coveredUntil(0), 20, 'the rest still loads');

  // LRU eviction under a tiny size cap: oldest-watched goes first.
  const small = new TranscriptCache({ storage: memoryStorage(), maxBytes: 400 });
  await small.init();
  const t = (n) => { const w = new WordTimeline(); w.addWindow(0, 10, Array.from({ length: n }, (_, i) => ({ text: ' word' + i, start: i * 0.5, end: i * 0.5 + 0.3 }))); return w; };
  await small.save('old:tiny.en', t(5));
  await new Promise((r) => setTimeout(r, 5));
  await small.save('mid:tiny.en', t(5));
  await new Promise((r) => setTimeout(r, 5));
  await small.load('old:tiny.en', new WordTimeline()); // watched again: now most recent
  await new Promise((r) => setTimeout(r, 5));
  await small.save('new:tiny.en', t(5));
  assert(small.has('new:tiny.en') && small.has('old:tiny.en'), 'recent ones kept');
  assert(!small.has('mid:tiny.en'), 'least recently watched evicted');
  assert(!small.storage.m.has('ce:t:mid:tiny.en'), 'its data removed too');
  console.log('transcript cache tests passed');
})();

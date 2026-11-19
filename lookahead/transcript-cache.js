// Saves each video's transcript so rewatching starts with no delay
// (roadmap step 1.6). Stored in the extension's own storage (not the page's),
// keyed by video. Format 2 stores true word times (each engine's timing bias
// already removed); format 1 (raw, per-model times) is ignored.
// Least-recently-watched videos are dropped once the cache passes `maxBytes`.
//
//   const cache = new TranscriptCache();          // chrome.storage.local by default
//   await cache.init();
//   cache.has(key)                                 // known without a storage read
//   await cache.load(key, wordTimeline)            // merges a saved transcript in
//   await cache.save(key, wordTimeline)
(function (root) {
  const INDEX = 'ce:t:index';
  const PREFIX = 'ce:t:';

  // Compact form: words as [text, startMs, endMs], stretches as [fromMs, toMs].
  function serialize(words) {
    return {
      v: 2,
      // Optional 4th element: 1 = placed by forced alignment (step 5.2);
      // 5th and 6th: speaker label and confidence ×1000 (step 8).
      words: words.words.map((w) => {
        const row = [w.text, Math.round(w.start * 1000), Math.round(w.end * 1000)];
        if (w.aligned || w.speaker != null) row.push(w.aligned ? 1 : 0);
        if (w.speaker != null) row.push(w.speaker, Math.round((w.speakerConf || 0) * 1000));
        return row;
      }),
      covered: words.covered.map(([a, b]) => [Math.round(a * 1000), Math.round(b * 1000)]),
    };
  }

  function merge(words, data) {
    if (!data || data.v !== 2) return false;
    const all = data.words.map(([text, s, e, a, spk, conf]) => {
      const w = { text, start: s / 1000, end: e / 1000 };
      if (a) w.aligned = true;
      if (spk != null) {
        w.speaker = spk;
        w.speakerConf = (conf || 0) / 1000;
      }
      return w;
    });
    for (const [a, b] of data.covered) {
      const from = a / 1000;
      const to = b / 1000;
      // Don't overwrite stretches already transcribed in this session.
      if (words.coveredUntil(from) != null && words.coveredUntil(from) >= to) continue;
      words.addWindow(from, to, all.filter((w) => w.start >= from - 0.3 && w.start < to + 0.3));
    }
    return true;
  }

  class TranscriptCache {
    constructor({ storage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local, maxBytes = 8e6 } = {}) {
      this.storage = storage;
      this.maxBytes = maxBytes;
      this.index = {}; // key -> { bytes, at }
      this.ready = null;
    }

    init() {
      if (!this.ready) {
        this.ready = this.storage
          .get(INDEX)
          .then((r) => {
            this.index = (r && r[INDEX]) || {};
          })
          .catch(() => {
            this.index = {};
          });
      }
      return this.ready;
    }

    has(key) {
      return !!key && key in this.index;
    }

    async load(key, words) {
      await this.init();
      if (!this.has(key)) return false;
      const r = await this.storage.get(PREFIX + key);
      const ok = merge(words, r && r[PREFIX + key]);
      if (ok) {
        this.index[key].at = Date.now();
        await this.storage.set({ [INDEX]: this.index });
      }
      return ok;
    }

    async save(key, words) {
      await this.init();
      if (!key || !words.covered.length) return;
      const data = serialize(words);
      const bytes = JSON.stringify(data).length;
      this.index[key] = { bytes, at: Date.now() };
      // Drop least recently used transcripts until under the size cap.
      const drop = [];
      let total = Object.values(this.index).reduce((s, e) => s + e.bytes, 0);
      const oldest = Object.entries(this.index)
        .filter(([k]) => k !== key)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [k, e] of oldest) {
        if (total <= this.maxBytes) break;
        drop.push(k);
        total -= e.bytes;
        delete this.index[k];
      }
      if (drop.length) await this.storage.remove(drop.map((k) => PREFIX + k));
      await this.storage.set({ [PREFIX + key]: data, [INDEX]: this.index });
    }
  }

  root.TranscriptCache = TranscriptCache;
  if (typeof module !== 'undefined' && module.exports) module.exports = TranscriptCache;
})(typeof globalThis !== 'undefined' ? globalThis : self);

// Transcribed words by media time, plus which stretches have been
// transcribed (roadmap step 1.4). Kept per video, so seeking back to
// something already heard needs no new transcription.
//
//   const w = new WordTimeline();
//   w.addWindow(from, to, words)   // words: [{ text, start, end }] in media time
//   w.coveredUntil(t)              // end of the transcribed stretch containing t (or null)
//   w.between(t0, t1)              // words starting in [t0, t1)
(function (root) {
  const JOIN = 0.05; // stretches closer than this count as one
  const SEAM = 0.3; // how far past a window edge a word may be timed

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9*']/g, '');

  class WordTimeline {
    constructor() {
      this.words = []; // sorted by start
      this.covered = []; // sorted, disjoint [from, to]
      this.version = 0; // bumped on every change (used to know when to save)
    }

    // Record the result of transcribing [from, to): its words replace any
    // already stored there, and the stretch is marked as transcribed.
    addWindow(from, to, words) {
      const inside = (w) => w.start >= from && w.start < to;
      // A word right on a seam can be timed just outside the window by one
      // pass and just outside the neighbouring window by the next, so words
      // up to SEAM past either edge are kept too, unless already stored.
      const nearEdge = (w) => w.start >= from - SEAM && w.start < to + SEAM;
      const kept = this.words.filter((w) => !inside(w));
      for (const w of words) {
        if (!nearEdge(w)) continue;
        // Overlapping windows can report the same word just across a seam.
        const dupe = kept.some((k) => Math.abs(k.start - w.start) < SEAM && norm(k.text) === norm(w.text));
        if (!dupe) kept.push(w.aligned ? { text: w.text, start: w.start, end: w.end, aligned: true } : { text: w.text, start: w.start, end: w.end });
      }
      kept.sort((a, b) => a.start - b.start);
      this.words = kept;
      this.cover(from, to);
      this.version++;
    }

    cover(from, to) {
      if (!(to > from)) return;
      const merged = [];
      let s = from;
      let e = to;
      for (const [a, b] of this.covered) {
        if (b < s - JOIN || a > e + JOIN) merged.push([a, b]);
        else {
          s = Math.min(s, a);
          e = Math.max(e, b);
        }
      }
      merged.push([s, e]);
      merged.sort((x, y) => x[0] - y[0]);
      this.covered = merged;
    }

    coveredUntil(t) {
      for (const [a, b] of this.covered) if (a - JOIN <= t && t <= b) return b;
      return null;
    }

    aheadOf(t) {
      const end = this.coveredUntil(t);
      return end == null ? 0 : end - t;
    }

    between(t0, t1) {
      return this.words.filter((w) => w.start >= t0 && w.start < t1);
    }
  }

  root.WordTimeline = WordTimeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = WordTimeline;
})(typeof globalThis !== 'undefined' ? globalThis : self);

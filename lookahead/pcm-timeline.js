// Decoded 16 kHz audio stored by media time (roadmap step 1.3).
//
// Whisper reads from here; the scheduler asks how far ahead of the playhead
// audio is ready. Storage is per-second blocks with a per-sample "filled"
// mask, so out-of-order writes (seeks, re-fetches) just land in place.
//
//   const tl = new PcmTimeline();
//   tl.add({ time, samples });         // from OpusPcmDecoder
//   tl.read(t0, t1)                     // -> { samples, covered }  (0..1)
//   tl.readyAhead(t)                    // seconds of unbroken audio from t
//   tl.evict(playhead)                  // drop audio far behind/ahead
(function (root) {
  const SR = 16000;
  const STEP = SR / 100; // coverage checks every 10 ms

  class PcmTimeline {
    constructor({ keepBehind = 30, keepAhead = 600 } = {}) {
      this.keepBehind = keepBehind;
      this.keepAhead = keepAhead;
      this.blocks = new Map(); // second index -> { data, filled }
    }

    block(sec, create) {
      let b = this.blocks.get(sec);
      if (!b && create) {
        b = { data: new Float32Array(SR), filled: new Uint8Array(SR) };
        this.blocks.set(sec, b);
      }
      return b;
    }

    add({ time, samples }) {
      let idx = Math.round(time * SR);
      let i = 0;
      if (idx < 0) {
        i = -idx;
        idx = 0;
      }
      while (i < samples.length) {
        const sec = Math.floor(idx / SR);
        const off = idx - sec * SR;
        const n = Math.min(SR - off, samples.length - i);
        const b = this.block(sec, true);
        b.data.set(samples.subarray(i, i + n), off);
        b.filled.fill(1, off, off + n);
        i += n;
        idx += n;
      }
    }

    read(t0, t1) {
      const start = Math.max(0, Math.round(t0 * SR));
      const end = Math.max(start, Math.round(t1 * SR));
      const out = new Float32Array(end - start);
      let have = 0;
      for (let idx = start; idx < end; ) {
        const sec = Math.floor(idx / SR);
        const off = idx - sec * SR;
        const n = Math.min(SR - off, end - idx);
        const b = this.block(sec, false);
        if (b) {
          out.set(b.data.subarray(off, off + n), idx - start);
          for (let k = off; k < off + n; k++) have += b.filled[k];
        }
        idx += n;
      }
      return { samples: out, covered: out.length ? have / out.length : 0 };
    }

    has(idx) {
      const sec = Math.floor(idx / SR);
      const b = this.block(sec, false);
      return !!b && b.filled[idx - sec * SR] === 1;
    }

    // Seconds of unbroken decoded audio starting at media time t (10 ms steps).
    readyAhead(t, max = this.keepAhead) {
      const start = Math.max(0, Math.round(t * SR));
      const limit = start + Math.round(max * SR);
      let idx = start;
      // Tolerate a tiny hole at the very start (e.g. the decoder's first
      // sample lands 0.65 ms after 0) rather than reporting nothing ready.
      for (let k = 0; k < 2 * STEP && !this.has(idx); k++) idx++;
      if (!this.has(idx)) return 0;
      while (idx < limit && this.has(idx) && this.has(Math.min(idx + STEP - 1, limit))) idx += STEP;
      return (idx - start) / SR;
    }

    evict(playhead) {
      const lo = Math.floor(playhead - this.keepBehind);
      const hi = Math.ceil(playhead + this.keepAhead);
      for (const sec of this.blocks.keys()) if (sec < lo || sec > hi) this.blocks.delete(sec);
    }

    clear() {
      this.blocks.clear();
    }
  }

  root.PcmTimeline = PcmTimeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = PcmTimeline;
})(typeof globalThis !== 'undefined' ? globalThis : self);

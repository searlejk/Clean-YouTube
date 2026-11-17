// Works out when a moment of the video is actually heard (roadmap step 1.3).
//
// Two clocks are involved: the player's media clock (`currentTime`) and the
// Web Audio clock where the extension captures and mutes the sound. This
// class:
//   1. fits media time ≈ a · ctxTime + b from (ctxTime, currentTime) samples,
//      restarting the fit after seeks, pauses and rate changes;
//   2. self-calibrates the remaining fixed offset (player pipeline latency) by
//      matching loudness envelopes of the decoded lookahead audio against the
//      audio actually captured from the player, the method validated in 1.2.
//
//   const sync = new ClockSync({ timeline });
//   sync.notePlayhead(ctx.currentTime, el.currentTime, { paused, rate });
//   sync.noteCapture(ctxTimeOfFirstSample, float32Samples, sampleRate);
//   sync.calibrate();          // every few seconds while playing
//   sync.heardAt(mediaTime)    // -> Web Audio time it will be heard (or null)
(function (root) {
  const SR = 16000;
  const HOP = 16; // 1 ms at 16 kHz
  const WIN = 160; // 10 ms envelope window

  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  function envelope(x) {
    const n = Math.max(0, Math.floor((x.length - WIN) / HOP));
    const env = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let q = 0;
      const o = j * HOP;
      for (let i = o; i < o + WIN; i++) q += x[i] * x[i];
      env[j] = Math.sqrt(q / WIN);
    }
    return env;
  }

  class ClockSync {
    constructor({ timeline, windowSec = 6, maxLagMs = 300, minCorrelation = 0.8 } = {}) {
      this.timeline = timeline;
      this.windowSec = windowSec;
      this.maxLag = maxLagMs;
      this.minCorrelation = minCorrelation;
      this.run = null; // continuous-playback stretch: { pairs, rate, startCtx }
      this.blocks = []; // captured audio: { t, sr, data }
      this.estimates = []; // accepted offsets (s)
      this.lag = 0; // pipeline offset in seconds (median of estimates)
      this.lastCalibration = null;
    }

    // ── media clock ──

    notePlayhead(ctxTime, mediaTime, { paused = false, rate = 1 } = {}) {
      if (paused) {
        this.run = null;
        return;
      }
      if (this.run) {
        const f = this.fit();
        const jumped = f && Math.abs(f.a * ctxTime + f.b - mediaTime) > 0.25;
        if (jumped || rate !== this.run.rate) this.run = null; // seek or speed change
      }
      if (!this.run) this.run = { pairs: [], rate, startCtx: ctxTime };
      this.run.pairs.push([ctxTime, mediaTime]);
      if (this.run.pairs.length > 400) this.run.pairs.shift();
    }

    fit() {
      const p = this.run && this.run.pairs;
      if (!p || !p.length) return null;
      const n = p.length;
      const span = p[n - 1][0] - p[0][0];
      if (n < 5 || span < 0.3) {
        // Too little data for a slope yet: assume the nominal playback rate.
        const a = this.run.rate;
        const b = p.reduce((s, [x, y]) => s + (y - a * x), 0) / n;
        return { a, b };
      }
      const mx = p.reduce((s, q) => s + q[0], 0) / n;
      const my = p.reduce((s, q) => s + q[1], 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (const [x, y] of p) {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) ** 2;
      }
      const a = sxy / sxx;
      return { a, b: my - a * mx };
    }

    // Web Audio time at which media time `m` will be heard.
    heardAt(m) {
      const f = this.fit();
      return f ? (m - f.b - this.lag) / f.a : null;
    }

    // Media time being heard at Web Audio time `c`.
    mediaHeardAt(c) {
      const f = this.fit();
      return f ? f.a * c + f.b + this.lag : null;
    }

    // ── captured audio ──

    noteCapture(ctxTime, samples, sampleRate) {
      this.blocks.push({ t: ctxTime, sr: sampleRate, data: samples });
      const keepFrom = ctxTime - 15;
      while (this.blocks.length && this.blocks[0].t < keepFrom) this.blocks.shift();
    }

    // Captured audio between two Web Audio times, at 16 kHz (nearest sample),
    // using each block's own timestamp so a dropped block can't shift the rest.
    capturedAt16k(c0, c1) {
      const n = Math.max(0, Math.round((c1 - c0) * SR));
      const out = new Float32Array(n);
      let bi = 0;
      let missing = 0;
      for (let j = 0; j < n; j++) {
        const t = c0 + j / SR;
        while (bi + 1 < this.blocks.length && this.blocks[bi + 1].t <= t) bi++;
        const b = this.blocks[bi];
        const k = b ? Math.floor((t - b.t) * b.sr) : -1;
        if (b && k >= 0 && k < b.data.length) out[j] = b.data[k];
        else missing++;
      }
      return { samples: out, missing: n ? missing / n : 1 };
    }

    // ── self-calibration ──

    calibrate(nowCtx) {
      const f = this.fit();
      if (!f || !this.run || this.blocks.length < 2) return (this.lastCalibration = { accepted: false, reason: 'not enough data' });
      const end = Math.min(nowCtx ?? Infinity, this.blocks[this.blocks.length - 1].t);
      const start = Math.max(this.run.startCtx + 0.5, end - this.windowSec);
      if (end - start < 2) return (this.lastCalibration = { accepted: false, reason: 'need 2 s of playback' });

      const cap = this.capturedAt16k(start, end);
      if (cap.missing > 0.05) return (this.lastCalibration = { accepted: false, reason: 'gaps in capture' });
      const m0 = f.a * start + f.b;
      const m1 = f.a * end + f.b;
      const pad = this.maxLag / 1000 + 0.02;
      const dec = this.timeline.read(m0 - pad, m1 + pad);
      if (dec.covered < 0.95) return (this.lastCalibration = { accepted: false, reason: 'decoded audio missing' });

      const ec = envelope(cap.samples);
      const ed = envelope(dec.samples);
      const shift = Math.round((pad * SR) / HOP); // ed index of m0
      const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
      const mc = mean(ec);
      const md = mean(ed);
      let energy = 0;
      for (const v of ec) energy += (v - mc) ** 2;
      if (Math.sqrt(energy / (ec.length || 1)) < 0.003) return (this.lastCalibration = { accepted: false, reason: 'too quiet' });

      let best = { lag: 0, r: -2 };
      for (let lag = -this.maxLag; lag <= this.maxLag; lag++) {
        let xy = 0;
        let xx = 0;
        let yy = 0;
        for (let j = 0; j < ec.length; j++) {
          const d = ed[j + shift + lag];
          if (d === undefined) continue;
          const x = d - md;
          const y = ec[j] - mc;
          xy += x * y;
          xx += x * x;
          yy += y * y;
        }
        const r = xy / Math.sqrt(xx * yy + 1e-20);
        if (r > best.r) best = { lag, r };
      }
      const accepted = best.r >= this.minCorrelation;
      if (accepted) {
        this.estimates.push(best.lag / 1000);
        if (this.estimates.length > 7) this.estimates.shift();
        this.lag = median(this.estimates);
      }
      return (this.lastCalibration = { accepted, lagMs: best.lag, r: +best.r.toFixed(3), offsetMs: Math.round(this.lag * 1000) });
    }
  }

  root.ClockSync = ClockSync;
  if (typeof module !== 'undefined' && module.exports) module.exports = ClockSync;
})(typeof globalThis !== 'undefined' ? globalThis : self);

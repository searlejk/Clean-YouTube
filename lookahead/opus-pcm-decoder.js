// Decodes Opus packets from WebmOpusDemuxer into 16 kHz mono PCM for Whisper
// (roadmap step 1.2), using the browser's WebCodecs AudioDecoder.
//
//   const pcm = new OpusPcmDecoder({ onPcm });
//   demuxer: onConfig: c => pcm.configure(c), onFrame: f => pcm.decode(f)
//   pcm.reset();   // after a seek: drop filter history
//
// onPcm({ time, samples }) — `time` is the media time (seconds) of samples[0];
// `samples` is a Float32Array at 16 kHz. Chrome's Opus decoder already drops
// the stream's start-up padding (pre-skip) without shifting timestamps, so
// block timestamps are used as-is (verified against ffmpeg: 0.0 ms offset).
(function (root) {
  const OUT_RATE = 16000;
  const TAPS = 63; // low-pass FIR for 48 kHz → 16 kHz (cutoff ~7.2 kHz)

  function designLowpass(taps, cutoff) {
    const h = new Float32Array(taps);
    const m = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - m;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      h[i] = sinc * window;
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    return h;
  }

  class OpusPcmDecoder {
    constructor({ onPcm, onError } = {}) {
      this.onPcm = onPcm || (() => {});
      this.onError = onError || ((e) => console.warn('[OpusPcmDecoder]', e));
      this.decoder = null;
      this.config = null;
      this.stats = { packets: 0, outputs: 0, discontinuities: 0, errors: 0 };
      this.resetFilter();
    }

    configure(cfg) {
      this.config = cfg;
      this.inRate = cfg.sampleRate;
      this.factor = Math.round(cfg.sampleRate / OUT_RATE); // 3 for 48 kHz
      this.fir = designLowpass(TAPS, (0.45 * OUT_RATE) / cfg.sampleRate);
      this.createDecoder();
      this.resetFilter();
    }

    createDecoder() {
      try {
        this.decoder?.close();
      } catch {
        // already closed
      }
      this.decoder = new AudioDecoder({
        output: (audio) => this.onAudio(audio),
        error: (e) => {
          this.stats.errors++;
          this.onError(e);
          // Opus packets are independent, so a fresh decoder can carry on.
          if (this.config) this.createDecoder();
        },
      });
      const { codec, sampleRate, channels, codecPrivate } = this.config;
      this.decoder.configure({ codec, sampleRate, numberOfChannels: channels, description: codecPrivate });
    }

    decode({ timestampUs, data }) {
      if (!this.decoder || this.decoder.state !== 'configured') return;
      this.stats.packets++;
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestampUs, data }));
    }

    async flush() {
      if (this.decoder && this.decoder.state === 'configured') await this.decoder.flush();
    }

    reset() {
      this.resetFilter();
    }

    resetFilter() {
      this.history = new Float32Array(0); // last TAPS-1 mono input samples
      this.phase = 0; // input samples to skip before the next output sample
      this.nextInputTime = null; // expected time of the next decoded sample (s)
    }

    onAudio(audio) {
      try {
        this.stats.outputs++;
        const n = audio.numberOfFrames;
        const ch = audio.numberOfChannels;
        const mono = new Float32Array(n);
        const plane = new Float32Array(n);
        for (let c = 0; c < ch; c++) {
          audio.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
        }
        const start = audio.timestamp / 1e6;
        const rate = audio.sampleRate;
        if (this.nextInputTime != null && Math.abs(start - this.nextInputTime) > 0.002) {
          this.stats.discontinuities++;
          this.resetFilter();
        }
        this.nextInputTime = start + n / rate;
        this.downsample(mono, start, rate);
      } finally {
        audio.close();
      }
    }

    // FIR low-pass + keep every `factor`-th sample, carrying state across
    // packets so there are no seams every 20 ms.
    downsample(mono, start, rate) {
      const h = this.fir;
      const hist = this.history;
      const x = new Float32Array(hist.length + mono.length);
      x.set(hist);
      x.set(mono, hist.length);
      const out = [];
      // First output position (index into x) that has a full window behind it.
      let i = Math.max(this.phase + hist.length, TAPS - 1);
      if (i < hist.length) i = hist.length;
      const firstIndex = i;
      for (; i < x.length; i += this.factor) {
        let acc = 0;
        for (let k = 0; k < TAPS; k++) acc += h[k] * x[i - k];
        out.push(acc);
      }
      this.phase = i - x.length; // carry the decimation phase into the next packet
      this.history = x.slice(Math.max(0, x.length - (TAPS - 1)));
      if (!out.length) return;
      // x[firstIndex] is mono[firstIndex - hist.length]; the FIR's group delay
      // is (TAPS-1)/2 input samples.
      const t = start + (firstIndex - hist.length - (TAPS - 1) / 2) / rate;
      this.onPcm({ time: t, samples: Float32Array.from(out) });
    }
  }

  root.OpusPcmDecoder = OpusPcmDecoder;
  if (typeof module !== 'undefined' && module.exports) module.exports = OpusPcmDecoder;
})(typeof globalThis !== 'undefined' ? globalThis : self);

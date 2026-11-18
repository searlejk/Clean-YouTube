// Decodes Opus packets from WebmOpusDemuxer into 16 kHz mono PCM for Whisper
// (roadmap step 1.2), using the browser's WebCodecs AudioDecoder.
//
//   const pcm = new OpusPcmDecoder({ onPcm });
//   demuxer: onConfig: c => pcm.configure(c), onFrame: f => pcm.decode(f)
//   pcm.reset();   // after a seek: fresh decoder state and filter history
//
// onPcm({ time, samples }) — `time` is the media time (seconds) of samples[0];
// `samples` is a Float32Array at 16 kHz.
// onFullPcm({ time, rate, planes }) (optional) — the same audio at the
// decoder's own rate (48 kHz), one Float32Array per channel, for voice
// separation (roadmap step 4.2).
//
// Timestamps: Chrome's AudioDecoder ignores jumps in input timestamps and keeps
// counting from where it was (after a seek from 35.8 s to 45.0 s its output was
// stamped 35.8 s). So each output is matched, in order, to the packet it came
// from. In WebM a packet's audio starts at its container timestamp minus the
// stream's pre-skip (from the OpusHead); if the decoder trimmed the front of a
// packet (it does for the first one after a start or reset), the start moves
// by the trimmed length, computed from the packet's own TOC header.
// Container timestamps are whole milliseconds, so while packets are
// continuous the start is carried forward by counting samples (exact), and it
// only re-anchors to the container timestamp on a real jump (> 3 ms).
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

  // Duration of an Opus packet in seconds, from its TOC byte (RFC 6716 §3.1).
  function opusPacketDuration(data) {
    if (!data || !data.length) return 0;
    const toc = data[0];
    const config = toc >> 3;
    let frameMs;
    if (config < 12) frameMs = [10, 20, 40, 60][config % 4];
    else if (config < 16) frameMs = [10, 20][config % 2];
    else frameMs = [2.5, 5, 10, 20][config % 4];
    const code = toc & 3;
    const frames = code === 0 ? 1 : code === 3 ? (data[1] || 0) & 0x3f : 2;
    return (frames * frameMs) / 1000;
  }

  class OpusPcmDecoder {
    constructor({ onPcm, onFullPcm, onError } = {}) {
      this.onPcm = onPcm || (() => {});
      this.onFullPcm = onFullPcm || null; // checked per packet, so it can be set later
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
      const head = cfg.codecPrivate;
      const isOpusHead = head && head.length >= 12 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead';
      this.preSkipSec = isOpusHead ? (head[10] | (head[11] << 8)) / 48000 : 0;
      this.createDecoder();
      this.resetFilter();
    }

    createDecoder() {
      try {
        this.decoder?.close();
      } catch {
        // already closed
      }
      this.pending = []; // packets sent to the decoder, oldest first
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
      this.pending.push({ time: timestampUs / 1e6, duration: opusPacketDuration(data) });
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestampUs, data }));
    }

    async flush() {
      if (this.decoder && this.decoder.state === 'configured') await this.decoder.flush();
    }

    // After a seek: drop queued packets and decoder state (so outputs can't be
    // attributed to the wrong packets) and the filter history.
    reset() {
      if (this.config && this.decoder && this.decoder.state === 'configured') {
        this.decoder.reset();
        const { codec, sampleRate, channels, codecPrivate } = this.config;
        this.decoder.configure({ codec, sampleRate, numberOfChannels: channels, description: codecPrivate });
      }
      this.pending = [];
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
        const planes = [];
        for (let c = 0; c < ch; c++) {
          const plane = new Float32Array(n);
          audio.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
          planes.push(plane);
        }
        const rate = audio.sampleRate;
        const packet = this.pending.shift();
        if (!packet) return; // output from before a reset
        // A packet shorter than its nominal length was trimmed at the front.
        const trimmed = Math.max(0, packet.duration - n / rate);
        const anchored = packet.time - this.preSkipSec + (trimmed > 0.0005 ? trimmed : 0);
        let start = anchored;
        if (this.nextInputTime != null) {
          if (Math.abs(anchored - this.nextInputTime) <= 0.003) {
            start = this.nextInputTime; // continuous: exact sample count
          } else {
            this.stats.discontinuities++;
            this.resetFilter();
          }
        }
        this.nextInputTime = start + n / rate;
        if (this.onFullPcm) this.onFullPcm({ time: start, rate, planes });
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

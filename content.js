// Clean Ears content script.
//
// Pipeline for every <video> on YouTube:
//   video ─► MediaElementSource ─► inputBus ─┬─► DelayNode(delay) ─► censorGain ─► flushGain ─► readyGain ─► speakers
//                                           └─► capture worklet ─► 16 kHz ─► Whisper (offscreen) ─► word timestamps
// The picture is held back by the same amount by drawing delayed frames onto a
// canvas laid over the (hidden) real video. Because Whisper hears the audio
// `delay` seconds before you do, swear words can be muted or bleeped on time.
(() => {
  if (window.__cleanEarsLoaded) return;
  window.__cleanEarsLoaded = true;

  const SR = 16000;
  // Whisper's word timestamps run late, by an amount that depends on the
  // model (measured against the waveform: starts ~0.3 s late for Base and up
  // to ~0.8 s for Tiny; ends a little less). Uncorrected, the "sh" of a swear
  // would leak. Each caught word is shifted back by the model's lag and
  // covered by settings.cover seconds on both sides.
  const timestampLag = () => PF.MODELS[settings.model]?.timestampLag ?? { start: 0.3, end: 0.1 };
  const RAMP = 0.008; // short fades avoid clicks
  const MERGE_GAP = 0.05;

  // Automatic delay = the shortest hold-back that still lets a word be heard,
  // transcribed and covered before it plays. For every word Whisper finds (not
  // just swears) we record how long after its cover would have to start we
  // learned of it; the delay covers the 95th percentile of that plus a margin.
  // Until enough words have been seen, a worst-case estimate from pass times
  // is used: a word ending just after a pass grabbed its audio is only found
  // at the end of the next pass, i.e. two pass durations.
  const LONGEST_WORD = 0.7;
  const PIPELINE_OVERHEAD = 0.15; // capture chunk + messaging
  const AUTO_SAFETY = 0.15;
  const LATE_BUMP = 0.3; // added to the automatic delay each time a word is caught late
  const MIN_DELAY = 1.0;
  const MAX_DELAY = 6;
  const FALLBACK_DELAY = 3; // safe start until this computer's speed has been measured
  let currentDelay = FALLBACK_DELAY;
  let passTimes = []; // recent Whisper pass durations, ms
  let needs = []; // per-word: delay that word needed, seconds
  let seenWordStarts = []; // stream times of words already measured
  let prevWindowEnd = -Infinity;
  let storedNeed = null; // measured in an earlier session
  let lateBump = 0;
  let flushUntil = 0;
  // Audio captured before the last seek/pause never plays; a Whisper pass that
  // was already running on it must not count as "late" or skew the timing.
  let staleBefore = 0;

  let settings = { ...PF.DEFAULTS };
  let compiled = PFFilter.compileWordList(settings.words);

  const state = {
    engine: 'idle', // idle | connecting | loading | ready | error | disconnected
    progress: 0,
    device: null,
    message: '',
    processingMs: 0,
    headroom: null,
    caught: 0,
    missed: 0,
    recent: [],
    lastText: '',
  };

  // ───────────────────────── settings ─────────────────────────

  chrome.storage.sync.get(PF.DEFAULTS).then((s) => {
    settings = s;
    compiled = PFFilter.compileWordList(settings.words);
    applySettings(true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const prev = { ...settings };
    for (const [k, { newValue }] of Object.entries(changes)) {
      settings[k] = newValue === undefined ? PF.DEFAULTS[k] : newValue;
    }
    if (changes.words) compiled = PFFilter.compileWordList(settings.words);
    if (changes.model) {
      passTimes = [];
      needs = [];
      storedNeed = null;
      lateBump = 0;
      if (port) port.postMessage({ type: 'config', model: settings.model });
    }
    applySettings(false, prev);
  });

  function applySettings(initial, prev = {}) {
    if (settings.enabled) {
      scan();
      if (anyPlaying()) connectEngine();
    }
    if (!ctx) {
      currentDelay = targetDelay();
      return;
    }
    const delayChanged = setDelay(targetDelay());
    if (initial || prev.enabled !== settings.enabled || delayChanged) {
      delayNode.delayTime.setValueAtTime(settings.enabled ? currentDelay : 0, ctx.currentTime);
      route();
      if (settings.enabled) flush();
    }
    reschedule();
    updateReadyGate();
    for (const d of delayers) d.setActive(settings.enabled);
    updateBadges();
  }

  function percentile(arr, q) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  }

  function measuredNeed() {
    if (needs.length >= 12) return percentile(needs, 0.95);
    return storedNeed;
  }

  function targetDelay() {
    if (!settings.autoDelay) return settings.delay;
    let d;
    const need = measuredNeed();
    if (need != null) {
      d = need + AUTO_SAFETY + lateBump;
    } else {
      const pass = passTimes.length >= 5 ? percentile(passTimes, 0.9) / 1000 : null;
      if (pass == null) return FALLBACK_DELAY + lateBump;
      d = LONGEST_WORD + 2 * pass + PIPELINE_OVERHEAD + timestampLag().start + settings.cover + AUTO_SAFETY + lateBump;
    }
    return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.ceil(d * 10) / 10));
  }

  // How much delay each newly heard word needed: its cover has to start
  // before it plays, i.e. capture time of (onset − lead) + delay ≥ now.
  function measureWordLatency(words, windowEnd) {
    const now = ctx.currentTime;
    const lead = timestampLag().start + settings.cover;
    for (const w of words) {
      // A word that was already fully audible before the previous pass is a
      // re-transcription, not a new word.
      if (w.start < prevWindowEnd - 1) continue;
      if (seenWordStarts.some((t) => Math.abs(t - w.start) < 0.25)) continue;
      seenWordStarts.push(w.start);
      const at = timeOf(w.start - lead);
      if (at == null) continue;
      needs.push(now - at);
      if (needs.length > 150) needs.shift();
    }
    seenWordStarts = seenWordStarts.filter((t) => t > windowEnd - 15);
    prevWindowEnd = windowEnd;
  }

  // Changing the delay mid-stream would skip or repeat audio, so it's only
  // applied at moments that are already a break: play, seek, new video, or
  // when it must grow to stop words slipping through.
  function setDelay(d) {
    if (Math.abs(d - currentDelay) < 0.05) return false;
    currentDelay = d;
    if (ctx && settings.enabled) delayNode.delayTime.setValueAtTime(d, ctx.currentTime);
    return true;
  }

  // Grows only on real evidence (enough measured words, or a word caught
  // late) so a rough early estimate doesn't add an unnecessary pause.
  function growDelayIfNeeded(late = false) {
    if (!settings.autoDelay) return;
    if (!late && needs.length < 12) return;
    const target = targetDelay();
    if (target > currentDelay + 0.2) {
      setDelay(target);
      flush();
      for (const d of delayers) d.clear();
    }
  }

  // Remember the measured need per model and processor, so the next video
  // starts at the right delay instead of the fallback.
  function needKey() {
    return `autoDelayNeed:${settings.model}:${state.device || 'unknown'}`;
  }

  function loadStoredNeed() {
    const key = needKey();
    chrome.storage.local.get(key).then((r) => {
      if (r[key] != null) storedNeed = r[key];
    });
  }

  // ───────────────────────── audio graph ─────────────────────────

  let ctx = null;
  let inputBus, delayNode, censorGain, flushGain, readyGain, bleepGain, captureNode;
  let routedToDelay = null;

  function ensureAudio() {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'playback' });
    inputBus = ctx.createGain();
    delayNode = ctx.createDelay(10);
    delayNode.delayTime.value = settings.enabled ? currentDelay : 0;
    censorGain = ctx.createGain();
    flushGain = ctx.createGain();
    readyGain = ctx.createGain();
    delayNode.connect(censorGain).connect(flushGain).connect(readyGain).connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    bleepGain = ctx.createGain();
    bleepGain.gain.value = 0;
    osc.connect(bleepGain).connect(ctx.destination);
    osc.start();

    ctx.onstatechange = updateBadges;
    setupCapture();
    route();
    updateReadyGate();

    // Autoplay policy: the context may start suspended until the user interacts.
    const resume = () => ctx.state !== 'running' && ctx.resume().catch(() => {});
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
    resume();
  }

  async function setupCapture() {
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'));
      captureNode = new AudioWorkletNode(ctx, 'pf-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
      captureNode.port.onmessage = ({ data }) => onCapture(data.samples, data.time);
    } catch (err) {
      // Fallback if the page's CSP blocks the worklet module.
      console.warn('[Clean Ears] AudioWorklet unavailable, using ScriptProcessor', err);
      const size = 4096;
      captureNode = ctx.createScriptProcessor(size, 2, 1);
      captureNode.onaudioprocess = (e) => {
        const ib = e.inputBuffer;
        const a = ib.getChannelData(0);
        const b = ib.numberOfChannels > 1 ? ib.getChannelData(1) : null;
        const mono = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) mono[i] = b ? (a[i] + b[i]) * 0.5 : a[i];
        onCapture(mono, e.playbackTime - size / ctx.sampleRate);
      };
    }
    captureNode.connect(sink);
    routedToDelay = null;
    route();
  }

  function route() {
    if (!ctx) return;
    const on = !!settings.enabled;
    if (routedToDelay === on) return;
    inputBus.disconnect();
    if (on) {
      inputBus.connect(delayNode);
      if (captureNode) inputBus.connect(captureNode);
    } else {
      inputBus.connect(ctx.destination);
      intervals = [];
    }
    routedToDelay = captureNode ? on : null;
  }

  // Optionally keep the sound off until Whisper is loaded and listening.
  function updateReadyGate() {
    if (!ctx) return;
    const closed = settings.enabled && settings.muteUntilReady && state.engine !== 'ready';
    readyGain.gain.setTargetAtTime(closed ? 0 : 1, ctx.currentTime, 0.01);
  }

  // After a seek / new video the delay line still holds stale audio: silence it.
  function flush() {
    if (!ctx) return;
    const now = ctx.currentTime;
    const g = flushGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + RAMP);
    g.setValueAtTime(0, now + currentDelay);
    g.linearRampToValueAtTime(1, now + currentDelay + 0.03);
    flushUntil = now + currentDelay;
    updateBadges();
    setTimeout(updateBadges, currentDelay * 1000 + 50);
  }

  // ───────────────────────── capture → Whisper ─────────────────────────

  class Downsampler {
    constructor(inRate, outRate) {
      this.ratio = inRate / outRate;
      this.pos = 0;
      this.acc = 0;
      this.cnt = 0;
    }
    process(input) {
      const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
      let n = 0;
      for (let i = 0; i < input.length; i++) {
        this.acc += input[i];
        this.cnt++;
        if (++this.pos >= this.ratio) {
          out[n++] = this.acc / this.cnt;
          this.acc = 0;
          this.cnt = 0;
          this.pos -= this.ratio;
        }
      }
      return out.subarray(0, n);
    }
  }

  let downsampler = null;
  let sentSamples = 0; // running count of 16 kHz samples sent to the engine
  let anchors = []; // [{ index, time }] maps sample index → AudioContext time

  function onCapture(samples, time) {
    if (!settings.enabled || !port || !anyPlaying()) return;
    if (!downsampler) downsampler = new Downsampler(ctx.sampleRate, SR);
    const out = downsampler.process(samples);
    if (!out.length) return;
    anchors.push({ index: sentSamples, time });
    sentSamples += out.length;
    while (anchors.length > 2 && anchors[1].time < time - 30) anchors.shift();
    port.postMessage({ type: 'audio', samples: Array.from(out) });
  }

  function timeOf(streamSeconds) {
    const idx = streamSeconds * SR;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i].index <= idx) return anchors[i].time + (idx - anchors[i].index) / SR;
    }
    return anchors.length ? anchors[0].time + (idx - anchors[0].index) / SR : null;
  }

  let port = null;
  let connecting = false;

  // Whisper only stays loaded while something is playing. After a while with
  // nothing playing, this tab lets go of the engine; once no tab is using it,
  // the extension unloads the model and frees its memory.
  const IDLE_RELEASE_MS = 2 * 60 * 1000;
  let lastPlayingAt = 0;

  function anyPlaying() {
    for (const d of delayers) {
      const v = d.video;
      if (!v.paused && !v.ended && v.readyState > 1) return true;
    }
    return false;
  }

  setInterval(() => {
    if (anyPlaying()) {
      lastPlayingAt = Date.now();
      if (settings.enabled && !port) connectEngine();
    } else if (port && Date.now() - lastPlayingAt > IDLE_RELEASE_MS) {
      port.disconnect();
      port = null;
      state.engine = 'idle';
      updateReadyGate();
      updateBadges();
    }
  }, 5000);

  async function connectEngine() {
    if (port || connecting || !settings.enabled) return;
    if (!chrome.runtime?.id) return; // extension was reloaded; this script is orphaned
    connecting = true;
    state.engine = 'connecting';
    updateBadges();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pf:ensureOffscreen' });
      if (!res?.ok) throw new Error(res?.error || 'Could not start the speech engine');
      // A new engine session counts samples from zero again.
      sentSamples = 0;
      anchors = [];
      port = chrome.runtime.connect({ name: 'pf-audio' });
      port.onMessage.addListener(onEngineMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        state.engine = 'disconnected';
        updateReadyGate();
        updateBadges();
        setTimeout(() => anyPlaying() && connectEngine(), 2000);
      });
      port.postMessage({ type: 'config', model: settings.model });
    } catch (err) {
      state.engine = 'error';
      state.message = String(err?.message || err);
      updateBadges();
      setTimeout(() => anyPlaying() && connectEngine(), 5000);
    } finally {
      connecting = false;
    }
  }

  function onEngineMessage(msg) {
    if (msg.type === 'status') {
      state.engine = msg.state;
      state.progress = msg.progress ?? state.progress;
      state.device = msg.device ?? state.device;
      state.message = msg.message || '';
      if (msg.state === 'ready' && storedNeed == null) loadStoredNeed();
      updateReadyGate();
      updateBadges();
      return;
    }
    if (msg.type !== 'words' || !ctx || !settings.enabled) return;
    msg.words = msg.words.filter((w) => {
      const t = timeOf(w.start);
      return t != null && t >= staleBefore;
    });

    const delay = currentDelay;
    const pad = settings.cover;
    for (const m of PFFilter.findMatches(msg.words, compiled)) {
      const lag = timestampLag();
      const s = timeOf(m.start - lag.start - pad);
      const e = timeOf(m.end - lag.end + pad);
      if (s == null || e == null) continue;
      addInterval(s + delay, e + delay, m);
    }

    if (msg.processingMs) {
      passTimes.push(msg.processingMs);
      if (passTimes.length > 40) passTimes.shift();
      measureWordLatency(msg.words, msg.windowEnd);
      if (needs.length >= 12 && passTimes.length % 20 === 0) {
        chrome.storage.local.set({ [needKey()]: Math.round(measuredNeed() * 100) / 100 });
      }
      growDelayIfNeeded();
      state.processingMs = state.processingMs ? state.processingMs * 0.8 + msg.processingMs * 0.2 : msg.processingMs;
      const end = timeOf(msg.windowEnd);
      if (end != null) {
        const h = end + delay - ctx.currentTime;
        state.headroom = state.headroom == null ? h : state.headroom * 0.8 + h * 0.2;
      }
    }
    if (msg.text) state.lastText = msg.text.trim();
    updateBadges();
  }

  // ───────────────────────── censoring ─────────────────────────

  let intervals = []; // merged future mute windows, AudioContext time
  let history = []; // recent windows, used to count each word once

  function addInterval(s, e, match) {
    const now = ctx.currentTime;
    history = history.filter((h) => h.e > now - 15);
    const seen = history.some((h) => h.s < e && s < h.e);
    history.push({ s, e });

    if (e <= now) {
      if (!seen) {
        state.missed++;
        lateBump += LATE_BUMP;
        growDelayIfNeeded(true);
      }
      return;
    }
    if (!seen) {
      if (s < now) {
        lateBump += LATE_BUMP;
        setTimeout(() => growDelayIfNeeded(true), 0);
      }
      state.caught++;
      state.recent.unshift({ word: match.text, rule: match.rule, late: s < now, at: Date.now() });
      state.recent.length = Math.min(state.recent.length, 10);
    }
    intervals.push({ s, e });
    reschedule();
  }

  function reschedule() {
    if (!ctx) return;
    const now = ctx.currentTime;
    const merged = [];
    for (const iv of intervals.filter((i) => i.e > now).sort((a, b) => a.s - b.s)) {
      const last = merged[merged.length - 1];
      if (last && iv.s <= last.e + MERGE_GAP) last.e = Math.max(last.e, iv.e);
      else merged.push({ ...iv });
    }
    intervals = merged;

    const g = censorGain.gain;
    const b = bleepGain.gain;
    const vol = settings.mode === 'bleep' ? settings.bleepVolume : 0;
    g.cancelAndHoldAtTime(now);
    b.cancelAndHoldAtTime(now);
    for (const iv of intervals) {
      const rampStart = iv.s - RAMP;
      if (rampStart > now) {
        g.setValueAtTime(1, rampStart);
        b.setValueAtTime(0, rampStart);
      }
      const full = Math.max(iv.s, now + RAMP);
      g.linearRampToValueAtTime(0, full);
      b.linearRampToValueAtTime(vol, full);
      g.setValueAtTime(0, Math.max(iv.e, full));
      b.setValueAtTime(vol, Math.max(iv.e, full));
      g.linearRampToValueAtTime(1, Math.max(iv.e, full) + RAMP);
      b.linearRampToValueAtTime(0, Math.max(iv.e, full) + RAMP);
    }
    if (!intervals.length) {
      g.linearRampToValueAtTime(1, now + RAMP);
      b.linearRampToValueAtTime(0, now + RAMP);
    }
  }

  // ───────────────────────── delayed picture ─────────────────────────
  //
  // Holding `delay` seconds of raw frames would cost gigabytes (1080p60 for 3 s
  // is ~1.5 GB per video), so frames are compressed with the hardware video
  // encoder as they arrive and decoded again just before they're shown. The
  // buffer is then a few MB. If WebCodecs can't be used, a small low-res
  // bitmap buffer is the fallback.

  const delayers = new Set();
  const KEYFRAME_MS = 1000; // a keyframe every second lets us skip ahead / resume quickly
  const DECODE_LEAD_MS = 150; // start decoding a frame this long before it's due
  const MAX_DECODED = 10;
  const MAX_ENCODE_WIDTH = 1920;
  const FALLBACK_WIDTH = 640;
  const FALLBACK_FPS = 30;

  const encoderConfigCache = new Map();
  function pickEncoderConfig(w, h) {
    const key = w + 'x' + h;
    if (!encoderConfigCache.has(key)) {
      encoderConfigCache.set(
        key,
        (async () => {
          if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return null;
          const bitrate = Math.round(Math.min(12e6, Math.max(1.5e6, w * h * 4)));
          for (const codec of ['avc1.640034', 'avc1.4d0034', 'vp8']) {
            const config = { codec, width: w, height: h, bitrate, framerate: 60, latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware' };
            if (codec.startsWith('avc1')) config.avc = { format: 'annexb' };
            try {
              if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
            } catch {
              // try the next codec
            }
          }
          return null;
        })()
      );
    }
    return encoderConfigCache.get(key);
  }

  class VideoDelay {
    constructor(video) {
      this.video = video;
      this.active = false;
      this.frameHandle = null;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'pf-canvas';
      this.c2d = this.canvas.getContext('2d', { alpha: false });
      this.box = '';
      this.fit = 'contain';
      this.fitCheckedAt = 0;

      this.useBitmaps = typeof VideoEncoder === 'undefined';
      this.bitmaps = []; // fallback: [{ t, bmp }]
      this.lastBitmapT = 0;

      this.encoder = null;
      this.decoder = null;
      this.encSize = '';
      this.encReady = false;
      this.encCfg = null; // decoder config matching the encoder's current output
      this.decCfg = null; // config the decoder is currently set up with
      this.scaler = null; // OffscreenCanvas used when the source must be resized
      this.needKey = true;
      this.lastKeyT = -Infinity;
      this.chunks = []; // [{ t, chunk, cfg }] encoded frames waiting to be shown
      this.decoded = []; // VideoFrames ready to draw
      this.clearedAt = 0;

      // Which moment of the video is on screen, so pause and skip can work
      // from what you see rather than from the real (ahead) playhead.
      this.frameTimes = []; // [{ t, m }] capture time → media time
      this.shownMediaTime = null;
      this.lastMediaTime = null; // newest frame the real element produced
      this.frozen = false;

      this.onFrame = this.onFrame.bind(this);
      this.render = this.render.bind(this);
      requestAnimationFrame(this.render);
    }

    setActive(on) {
      if (on === this.active) return;
      this.active = on;
      if (on) {
        this.mount();
        this.canvas.style.display = '';
        this.video.classList.add('pf-hidden');
        this.requestFrame();
      } else {
        this.video.classList.remove('pf-hidden');
        this.canvas.style.display = 'none';
        this.releaseCodecs();
      }
    }

    mount() {
      const parent = this.video.parentNode;
      if (parent && this.canvas.parentNode !== parent) parent.insertBefore(this.canvas, this.video.nextSibling);
    }

    requestFrame() {
      if (this.frameHandle == null && this.active) {
        this.frameHandle = this.video.requestVideoFrameCallback(this.onFrame);
      }
    }

    onFrame(now, meta) {
      this.frameHandle = null;
      if (!this.active) return;
      this.requestFrame();
      this.lastMediaTime = meta.mediaTime;
      if (this.video.paused) return; // seeks while paused are shown by showCurrent()
      this.frameTimes.push({ t: now, m: meta.mediaTime });
      if (this.frameTimes.length > currentDelay * 65 + 60) this.frameTimes.shift();
      if (this.useBitmaps) this.captureBitmap(now, meta.mediaTime);
      else this.encodeFrame(now);
    }

    // ── WebCodecs path ──

    encodeSize() {
      const v = this.video;
      if (!v.videoWidth || !v.videoHeight) return null;
      const scale = Math.min(1, MAX_ENCODE_WIDTH / v.videoWidth);
      const w = Math.round((v.videoWidth * scale) / 2) * 2;
      const h = Math.round((v.videoHeight * scale) / 2) * 2;
      return { w, h, scaled: w !== v.videoWidth || h !== v.videoHeight };
    }

    async configureEncoder(w, h) {
      const key = w + 'x' + h;
      this.encSize = key;
      this.encReady = false;
      const config = await pickEncoderConfig(w, h);
      if (this.encSize !== key || !this.active) return;
      if (!config) return this.switchToBitmaps('no supported video encoder');
      try {
        if (!this.encoder || this.encoder.state === 'closed') {
          this.encoder = new VideoEncoder({
            output: (chunk, meta) => this.onChunk(chunk, meta),
            error: (e) => this.switchToBitmaps(e),
          });
        }
        // Reconfiguring keeps already-encoded frames valid; each chunk remembers
        // the decoder config it needs, so quality switches don't blank the picture.
        this.encoder.configure(config);
      } catch (e) {
        return this.switchToBitmaps(e);
      }
      this.encCfg = { codec: config.codec, codedWidth: w, codedHeight: h };
      this.needKey = true;
      this.encReady = true;
    }

    encodeFrame(now) {
      const size = this.encodeSize();
      if (!size) return;
      if (size.w + 'x' + size.h !== this.encSize) {
        this.configureEncoder(size.w, size.h);
        return;
      }
      if (!this.encReady || this.encoder.state !== 'configured') return;
      if (this.encoder.encodeQueueSize > 4) {
        this.needKey = true; // falling behind: drop this frame
        return;
      }

      let frame;
      try {
        const timestamp = Math.round(now * 1000);
        if (size.scaled) {
          if (!this.scaler || this.scaler.width !== size.w || this.scaler.height !== size.h) {
            this.scaler = new OffscreenCanvas(size.w, size.h);
          }
          this.scaler.getContext('2d').drawImage(this.video, 0, 0, size.w, size.h);
          frame = new VideoFrame(this.scaler, { timestamp });
        } else {
          frame = new VideoFrame(this.video, { timestamp });
        }
        const keyFrame = this.needKey || now - this.lastKeyT >= KEYFRAME_MS;
        if (keyFrame) {
          this.needKey = false;
          this.lastKeyT = now;
        }
        this.encoder.encode(frame, { keyFrame });
      } catch {
        // frame not ready (e.g. mid-seek); skip it
      } finally {
        frame?.close();
      }
    }

    onChunk(chunk, meta) {
      if (meta?.decoderConfig) this.encCfg = meta.decoderConfig;
      const t = chunk.timestamp / 1000;
      if (!this.active || t < this.clearedAt) return;
      this.chunks.push({ t, chunk, cfg: this.encCfg });
      const max = Math.ceil(currentDelay * 62) + 120;
      if (this.chunks.length > max) this.chunks.splice(0, this.chunks.length - max);
    }

    onDecoded(frame) {
      if (!this.active || frame.timestamp / 1000 < this.clearedAt) return frame.close();
      this.decoded.push(frame);
      while (this.decoded.length > MAX_DECODED) this.decoded.shift().close();
    }

    feedDecoder(cutoff) {
      // Far behind (tab was in the background)? Jump to the newest due keyframe.
      if (this.chunks.length && this.chunks[0].t < cutoff - 500) {
        let k = -1;
        for (let i = 0; i < this.chunks.length && this.chunks[i].t <= cutoff; i++) {
          if (this.chunks[i].chunk.type === 'key') k = i;
        }
        if (k > 0) {
          this.chunks.splice(0, k);
          this.decCfg = null;
        }
      }
      if (!this.decoder || this.decoder.state === 'closed') {
        this.decoder = new VideoDecoder({
          output: (f) => this.onDecoded(f),
          error: (e) => this.switchToBitmaps(e),
        });
        this.decCfg = null;
      }
      while (this.chunks.length && this.chunks[0].t <= cutoff + DECODE_LEAD_MS && this.decoder.decodeQueueSize < 8) {
        const c = this.chunks.shift();
        if (c.cfg !== this.decCfg || this.decoder.state !== 'configured') {
          if (c.chunk.type !== 'key') continue;
          try {
            this.decoder.configure(c.cfg);
          } catch (e) {
            return this.switchToBitmaps(e);
          }
          this.decCfg = c.cfg;
        }
        this.decoder.decode(c.chunk);
      }
    }

    switchToBitmaps(reason) {
      if (this.useBitmaps) return;
      console.warn('[Clean Ears] hardware video buffer unavailable, using low-res fallback:', reason);
      this.useBitmaps = true;
      this.releaseCodecs();
    }

    releaseCodecs() {
      for (const c of [this.encoder, this.decoder]) {
        try {
          if (c && c.state !== 'closed') c.close();
        } catch {
          // already closed
        }
      }
      this.encoder = null;
      this.decoder = null;
      this.encSize = '';
      this.encReady = false;
      this.decCfg = null;
      this.scaler = null;
      this.clear();
    }

    // ── fallback path: small bitmaps, hard-capped ──

    captureBitmap(now, mediaTime) {
      if (now - this.lastBitmapT < 1000 / FALLBACK_FPS - 2) return;
      const v = this.video;
      if (!v.videoWidth || !v.videoHeight) return;
      this.lastBitmapT = now;
      const scale = Math.min(1, FALLBACK_WIDTH / v.videoWidth);
      createImageBitmap(v, {
        resizeWidth: Math.round(v.videoWidth * scale),
        resizeHeight: Math.round(v.videoHeight * scale),
        resizeQuality: 'low',
      })
        .then((bmp) => {
          if (!this.active || now < this.clearedAt) return bmp.close();
          this.bitmaps.push({ t: now, bmp, m: mediaTime });
          const max = Math.ceil(currentDelay * FALLBACK_FPS) + 5;
          while (this.bitmaps.length > max) this.bitmaps.shift().bmp.close();
        })
        .catch(() => {});
    }

    // ── drawing ──

    render() {
      requestAnimationFrame(this.render);
      if (!this.active) return;
      if (!this.video.isConnected) return this.destroy();
      this.mount();
      this.syncBox();
      if (this.frozen) return;
      const cutoff = performance.now() - currentDelay * 1000;

      if (this.useBitmaps) {
        let f = null;
        while (this.bitmaps.length && this.bitmaps[0].t <= cutoff) {
          if (f) f.bmp.close();
          f = this.bitmaps.shift();
        }
        if (f) {
          this.draw(f.bmp, f.bmp.width, f.bmp.height);
          this.shownMediaTime = f.m;
          f.bmp.close();
        }
        return;
      }

      this.feedDecoder(cutoff);
      let frame = null;
      while (this.decoded.length && this.decoded[0].timestamp / 1000 <= cutoff) {
        if (frame) frame.close();
        frame = this.decoded.shift();
      }
      if (frame) {
        this.draw(frame, frame.displayWidth, frame.displayHeight);
        this.noteShown(frame.timestamp / 1000);
        frame.close();
      }
    }

    syncBox() {
      const v = this.video;
      const box = `${v.offsetLeft},${v.offsetTop},${v.offsetWidth},${v.offsetHeight}`;
      if (box !== this.box) {
        this.box = box;
        Object.assign(this.canvas.style, {
          left: v.offsetLeft + 'px',
          top: v.offsetTop + 'px',
          width: v.offsetWidth + 'px',
          height: v.offsetHeight + 'px',
        });
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.round(v.offsetWidth * dpr));
        this.canvas.height = Math.max(1, Math.round(v.offsetHeight * dpr));
      }
      const t = performance.now();
      if (t - this.fitCheckedAt > 1000) {
        this.fitCheckedAt = t;
        this.fit = getComputedStyle(v).objectFit || 'contain';
      }
    }

    draw(src, sw, sh) {
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      const s = this.fit === 'cover' ? Math.max(cw / sw, ch / sh) : this.fit === 'fill' ? null : Math.min(cw / sw, ch / sh);
      this.c2d.fillStyle = '#000';
      this.c2d.fillRect(0, 0, cw, ch);
      if (s == null) this.c2d.drawImage(src, 0, 0, cw, ch);
      else {
        const w = sw * s;
        const h = sh * s;
        this.c2d.drawImage(src, (cw - w) / 2, (ch - h) / 2, w, h);
      }
    }

    // Media time of the picture on screen. Clamped to [playhead − delay,
    // playhead] in case drawing was throttled (e.g. a background tab).
    onScreenTime() {
      const head = this.video.currentTime;
      const lo = head - currentDelay - 0.3;
      const t = this.shownMediaTime ?? head - currentDelay;
      return Math.min(head, Math.max(lo, t));
    }

    noteShown(t) {
      const q = this.frameTimes;
      while (q.length > 1 && q[1].t <= t + 0.5) q.shift();
      if (q.length && Math.abs(q[0].t - t) < 1) this.shownMediaTime = q[0].m;
    }

    // Paint the element's current frame right away (after a seek or on pause),
    // so you see where you landed while the audio ahead is being checked.
    showCurrent() {
      const v = this.video;
      if (!this.active || !v.videoWidth) return;
      this.mount();
      this.syncBox();
      try {
        this.draw(v, v.videoWidth, v.videoHeight);
        this.shownMediaTime = v.currentTime;
      } catch {
        // frame not decodable yet
      }
    }

    // Drop everything buffered (seek / new video). The canvas keeps showing the
    // last picture until new frames come due.
    clear() {
      this.frameTimes = [];
      this.clearedAt = performance.now();
      for (const f of this.bitmaps) f.bmp.close();
      this.bitmaps = [];
      for (const f of this.decoded) f.close();
      this.decoded = [];
      this.chunks = [];
      this.needKey = true;
      if (this.decoder && this.decoder.state === 'configured') {
        try {
          this.decoder.reset();
        } catch {
          // ignore
        }
      }
      this.decCfg = null;
    }

    destroy() {
      this.setActive(false);
      this.canvas.remove();
      delayers.delete(this);
    }
  }

  // ───────────────────────── hooking videos ─────────────────────────

  const hooked = new WeakMap();

  function hookVideo(video) {
    if (!(video instanceof HTMLVideoElement) || !settings.enabled) return;
    const existing = hooked.get(video);
    if (existing !== undefined) {
      if (existing && !delayers.has(existing)) {
        delayers.add(existing);
        existing.setActive(settings.enabled);
      }
      return;
    }
    ensureAudio();
    try {
      ctx.createMediaElementSource(video).connect(inputBus);
    } catch (err) {
      console.warn('[Clean Ears] could not attach to video', err);
      hooked.set(video, null);
      return;
    }
    const d = new VideoDelay(video);
    hooked.set(video, d);
    delayers.add(d);
    d.setActive(settings.enabled);

    let internalSeek = false;
    const seekTo = (t) => {
      t = Math.max(0, t);
      internalSeek = true;
      d.shownMediaTime = t;
      d.lastMediaTime = t;
      video.currentTime = t;
    };

    const discontinuity = () => {
      staleBefore = ctx.currentTime;
      prevWindowEnd = -Infinity;
      d.clear();
      if (settings.enabled) setDelay(targetDelay());
      flush();
      if (port) port.postMessage({ type: 'reset' });
    };

    video.addEventListener('seeking', () => {
      // The real playhead runs `delay` ahead of the picture, so YouTube's
      // "back 5 s" would land only ~2 s before what you were watching. Redo
      // keyboard skips relative to what's on screen.
      if (!internalSeek && settings.enabled && d.lastMediaTime != null && performance.now() - lastRelativeKeyAt < 700) {
        lastRelativeKeyAt = 0;
        // The playhead has already moved; work from the picture shown before it.
        const step = video.currentTime - d.lastMediaTime;
        const shownBefore = Math.min(d.lastMediaTime, Math.max(d.lastMediaTime - currentDelay - 0.3, d.shownMediaTime ?? d.lastMediaTime - currentDelay));
        const target = shownBefore + step;
        if (Math.abs(target - video.currentTime) > 0.2) {
          seekTo(target);
          return; // the corrected seek fires its own 'seeking'
        }
      }
      discontinuity();
    });
    video.addEventListener('seeked', () => {
      internalSeek = false;
      d.lastMediaTime = video.currentTime;
      d.showCurrent();
    });
    video.addEventListener('loadstart', discontinuity);

    // Pause stops the picture and sound right away (instead of letting the
    // delayed part play out) and rewinds the real playhead to the frame on
    // screen, so nothing is skipped when you press play again.
    video.addEventListener('pause', () => {
      if (!settings.enabled || video.ended || internalSeek) return;
      d.frozen = true;
      staleBefore = ctx.currentTime;
      flush();
      const shown = d.onScreenTime();
      if (video.currentTime - shown > 0.05) seekTo(shown);
    });
    video.addEventListener('play', () => {
      d.frozen = false;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      if (settings.enabled) {
        setDelay(targetDelay());
        flush();
      }
      lastPlayingAt = Date.now();
      connectEngine();
    });
    if (!video.paused) connectEngine();
    updateBadges();
  }

  let lastRelativeKeyAt = 0;
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (['ArrowLeft', 'ArrowRight', 'j', 'l', 'J', 'L'].includes(e.key)) lastRelativeKeyAt = performance.now();
    },
    true
  );

  function scan() {
    if (!settings.enabled) return;
    document.querySelectorAll('video').forEach(hookVideo);
  }

  // Catch videos the moment they start loading/playing (these events don't
  // bubble, but they do pass through the capture phase).
  for (const ev of ['loadstart', 'play']) {
    document.addEventListener(ev, (e) => hookVideo(e.target), true);
  }
  document.addEventListener('yt-navigate-finish', scan);
  setInterval(scan, 1500);

  // ───────────────────────── status badge ─────────────────────────

  const badges = new WeakMap();

  function badgeText() {
    if (!settings.enabled) return null;
    if (ctx && ctx.state === 'suspended') return { text: 'Clean Ears: click anywhere to turn the sound on', warn: true };
    switch (state.engine) {
      case 'idle':
        return anyPlaying() ? { text: 'Clean Ears: starting…' } : { text: 'Clean Ears: ready when you press play' };
      case 'connecting':
        return { text: 'Clean Ears: starting…' };
      case 'loading':
        return {
          text: state.message
            ? `Clean Ears: ${state.message}`
            : `Clean Ears: loading speech model ${Math.round((state.progress || 0) * 100)}%` +
              (settings.muteUntilReady ? ' (sound muted until ready)' : ' (not filtering yet)'),
          warn: true,
        };
      case 'error':
        return { text: `Clean Ears error: ${state.message}`, warn: true };
      case 'disconnected':
        return { text: 'Clean Ears: reconnecting…', warn: true };
    }
    if (ctx && ctx.currentTime < flushUntil && anyPlaying()) {
      return { text: `Clean Ears: checking ahead (${currentDelay.toFixed(1)} s)…` };
    }
    if (state.headroom != null && state.headroom < 0.25) {
      return { text: 'Clean Ears is falling behind – raise the delay or pick a smaller model', warn: true };
    }
    return { text: `Clean Ears on · ${state.caught} filtered` };
  }

  let lastBadgeText = '';
  function updateBadges() {
    const info = settings.showBadge ? badgeText() : null;
    for (const d of delayers) {
      const player = d.video.closest('.html5-video-player') || d.video.parentElement?.parentElement;
      if (!player) continue;
      let el = badges.get(player);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pf-badge';
        badges.set(player, el);
      }
      if (el.parentNode !== player) player.appendChild(el);
      if (!info) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.textContent = info.text;
      el.classList.toggle('pf-warn', !!info.warn);
      if (info.text !== lastBadgeText) {
        el.classList.add('pf-fresh');
        clearTimeout(el._pfTimer);
        el._pfTimer = setTimeout(() => el.classList.remove('pf-fresh'), 4000);
      }
    }
    lastBadgeText = info?.text || '';
  }

  // ───────────────────────── popup status ─────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'pf:getStatus') return;
    sendResponse({
      ...state,
      videos: delayers.size,
      audio: ctx ? ctx.state : 'none',
      enabled: settings.enabled,
      delay: currentDelay,
      autoDelay: settings.autoDelay,
      measuredNeed: measuredNeed(),
      wordsMeasured: needs.length,
    });
  });
})();

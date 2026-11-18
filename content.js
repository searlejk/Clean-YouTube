// Clean Ears content script.
//
// Pipeline for every <video> on YouTube:
//   video ─► MediaElementSource ─► inputBus ─┬─► DelayNode(delay) ─► censorGain ─► flushGain ─► readyGain ─► speakers
//                                           └─► capture worklet ─► 16 kHz ─► Whisper (offscreen) ─► word timestamps
// The picture is held back by the same amount by drawing delayed frames onto a
// canvas laid over the (hidden) real video. Because Whisper hears the audio
// `delay` seconds before you do, swear words can be muted or bleeped on time.
//
// Lookahead mode (roadmap step 1.5) removes the delay: lookahead/main-bridge.js
// hands over the audio YouTube has already downloaded, Whisper transcribes it
// before it plays, and mutes are placed by video time. The delay line is the
// fallback (see "lookahead mode" below).
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
  // Lookahead words are stored in true time: each reply is corrected by the
  // timing bias of the engine and model that produced it.
  function lagFor(reply) {
    if (reply.engine === 'companion') return PF.COMPANION_MODELS[reply.model]?.timestampLag ?? { start: 0.25, end: -0.05 };
    return PF.MODELS[reply.model]?.timestampLag ?? timestampLag();
  }
  const NO_LAG = { start: 0, end: 0 };
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
    asrSource: {}, // companion windows transcribed from the voice stem vs the full mix
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
    updateFullAudio();
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
    if (mode === 'lookahead' && !settings.lookahead) enterDelayMode();
    const delayChanged = setDelay(mode === 'lookahead' ? 0 : targetDelay());
    if (initial || prev.enabled !== settings.enabled || delayChanged) {
      delayNode.delayTime.setValueAtTime(settings.enabled ? currentDelay : 0, ctx.currentTime);
      route();
      if (settings.enabled) flush();
    }
    reschedule();
    updateReadyGate();
    for (const d of delayers) d.setActive(settings.enabled && mode === 'delay');
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
    const c = state.companion;
    if (c?.state === 'ready') return `autoDelayNeed:companion:${c.model}:${c.device || 'unknown'}`;
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

  // Test hook: a page opened with #cleanears-silent-test (remembered for the
  // tab) gets an AudioContext with no output device, so automated tests never
  // play sound, and publishes diagnostics on <html data-clean-ears>.
  const SILENT_TEST = (() => {
    try {
      if (location.hash.includes('cleanears-silent-test')) sessionStorage.setItem('cleanears-silent-test', '1');
      return sessionStorage.getItem('cleanears-silent-test') === '1';
    } catch {
      return false;
    }
  })();

  function ensureAudio() {
    if (ctx) return;
    ctx = new AudioContext(SILENT_TEST ? { latencyHint: 'playback', sinkId: { type: 'none' } } : { latencyHint: 'playback' });
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
    const closed = settings.enabled && settings.muteUntilReady && engineState() !== 'ready';
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
    if (!settings.enabled) return;
    const look = lookFor(activeVideo());
    if (look) look.sync.noteCapture(time, samples, ctx.sampleRate);
    if (mode !== 'delay' || !port || !anyPlaying()) return;
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
  const connLog = []; // test diagnostics: engine connects and disconnects
  let connecting = 0; // when the current start attempt began (0 = none)

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
    if (port || !settings.enabled) return;
    // A start that never answered (e.g. the background worker was restarted
    // mid-reply) mustn't block retries forever.
    if (connecting && performance.now() - connecting < 15000) return;
    if (!chrome.runtime?.id) {
      // The extension was reloaded or updated; this copy can't reach it.
      state.engine = 'error';
      state.message = 'Clean Ears was updated – reload this page';
      updateBadges();
      return;
    }
    const attempt = (connecting = performance.now());
    connLog.push({ at: Math.round(attempt), event: 'connect' });
    if (connLog.length > 20) connLog.shift();
    state.engine = 'connecting';
    updateBadges();
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage({ type: 'pf:ensureOffscreen' }),
        new Promise((_, no) => setTimeout(() => no(new Error('Speech engine did not start')), 15000)),
      ]);
      if (attempt !== connecting || port) return; // a newer attempt took over
      if (!res?.ok) throw new Error(res?.error || 'Could not start the speech engine');
      // A new engine session counts samples from zero again.
      sentSamples = 0;
      anchors = [];
      port = chrome.runtime.connect({ name: 'pf-audio' });
      port.onMessage.addListener(onEngineMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        for (const job of transcribeJobs.values()) job.reject(new Error('engine disconnected'));
        transcribeJobs.clear();
        state.engine = 'disconnected';
        state.companion = null;
        updateFullAudio();
        connLog.push({ at: Math.round(performance.now()), event: 'disconnected', error: chrome.runtime.lastError?.message });
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
      if (attempt === connecting) connecting = 0;
    }
  }

  function onEngineMessage(msg) {
    if (msg.type === 'transcribed') {
      const job = transcribeJobs.get(msg.id);
      transcribeJobs.delete(msg.id);
      if (!job) return;
      if (msg.error) job.reject(new Error(msg.error));
      else {
        state.processingMs = state.processingMs ? state.processingMs * 0.8 + msg.processingMs * 0.2 : msg.processingMs;
        state.lastEngine = msg.engine === 'companion' ? 'companion' : 'browser';
        if (msg.source) state.asrSource[msg.source] = (state.asrSource[msg.source] || 0) + 1;
        const lag = lagFor(msg);
        // Words the companion placed by forced alignment (step 5.2) are
        // already on the audio; only Whisper's own times need the bias fix.
        const words = (msg.words || []).map((w) => {
          const l = w.aligned ? NO_LAG : lag;
          return { text: w.text, start: w.start - l.start, end: w.end - l.end };
        });
        if (msg.engine === 'companion') state.alignedWords = (state.alignedWords || 0) + (msg.aligned || 0);
        job.resolve({ ...msg, words });
      }
      return;
    }
    if (msg.type === 'stem_clip') {
      onStemClip(msg);
      return;
    }
    if (msg.type === 'stems') {
      const look = looks.get(msg.stream);
      if (look) {
        look.stems = msg.ranges || [];
        look.speech = msg.speech || [];
      }
      return;
    }
    if (msg.type === 'companion') {
      const wasReady = state.companion?.state === 'ready';
      state.companion = msg;
      updateFullAudio();
      if (wasReady !== (msg.state === 'ready')) {
        storedNeed = null; // different engine, different speed
        loadStoredNeed();
      }
      updateReadyGate();
      updateBadges();
      return;
    }
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
    let lag = msg.engine ? lagFor(msg) : timestampLag();
    if (msg.engine) {
      // Companion words: aligned ones (step 5.2) are already on the audio.
      const l = lag;
      msg.words = msg.words.map((w) => (w.aligned ? w : { ...w, start: w.start - l.start, end: w.end - l.end }));
      lag = NO_LAG;
    }
    for (const m of PFFilter.findMatches(msg.words, compiled)) {
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

  // Lifetime "words blocked" total (shown in the popup). Each match counts
  // once, so a phrase like "son of a bitch" is one.
  function reportBlocked() {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'pf:blocked', count: 1 }).catch(() => {});
    } catch {
      // Extension reloaded; this page's copy can't report any more.
    }
  }

  function addInterval(s, e, match) {
    const now = ctx.currentTime;
    history = history.filter((h) => h.e > now - 15);
    const seen = history.some((h) => h.s < e && s < h.e);
    history.push({ s, e });

    if (e <= now) {
      if (!seen) {
        state.missed++;
        if (mode === 'delay') {
          lateBump += LATE_BUMP;
          growDelayIfNeeded(true);
        }
      }
      return;
    }
    if (!seen) {
      if (s < now && mode === 'delay') {
        lateBump += LATE_BUMP;
        setTimeout(() => growDelayIfNeeded(true), 0);
      }
      state.caught++;
      reportBlocked();
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
        existing.setActive(settings.enabled && mode === 'delay');
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
    d.setActive(settings.enabled && mode === 'delay');

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
      clearLookaheadMutes();
      if (port) port.postMessage({ type: 'reset' });
      if (mode === 'delay') {
        if (settings.enabled) setDelay(targetDelay());
        flush();
      }
    };
    d.seekTo = seekTo;
    d.isInternal = () => performance.now() < (video.__ceInternalUntil || 0);

    video.addEventListener('seeking', () => {
      // The real playhead runs `delay` ahead of the picture, so YouTube's
      // "back 5 s" would land only ~2 s before what you were watching. Redo
      // keyboard skips relative to what's on screen.
      if (!internalSeek && settings.enabled && currentDelay > 0 && d.lastMediaTime != null && performance.now() - lastRelativeKeyAt < 700) {
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
      if (!video.paused) chooseMode(video, d);
    });
    video.addEventListener('seeked', () => {
      internalSeek = false;
      d.lastMediaTime = video.currentTime;
      d.showCurrent();
    });
    video.addEventListener('loadstart', discontinuity);
    // Mutes already scheduled were timed for the old speed; the next tick
    // re-times them (ClockSync restarts its fit on a rate change).
    video.addEventListener('ratechange', () => clearLookaheadMutes());

    // Pause stops the picture and sound right away (instead of letting the
    // delayed part play out) and rewinds the real playhead to the frame on
    // screen, so nothing is skipped when you press play again.
    video.addEventListener('pause', () => {
      if (!settings.enabled || video.ended || internalSeek || d.isInternal()) return;
      if (holding && holding.video === video) holding = null; // user paused during a hold
      clearLookaheadMutes();
      if (mode === 'lookahead') return; // no delay: nothing still to play out
      d.frozen = true;
      staleBefore = ctx.currentTime;
      flush();
      const shown = d.onScreenTime();
      if (video.currentTime - shown > 0.05) seekTo(shown);
    });
    video.addEventListener('play', () => {
      d.frozen = false;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      lastPlayingAt = Date.now();
      connectEngine();
      if (d.isInternal() || !settings.enabled) return;
      chooseMode(video, d);
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

  // ───────────────────────── lookahead mode (no delay) ─────────────────────────
  //
  // The page bridge (lookahead/main-bridge.js) streams the audio YouTube has
  // already downloaded. It's transcribed ahead of the playhead (step 1.4) and,
  // when the transcript covers the next LOOKAHEAD_MIN seconds, the video plays
  // with no delay: the real <video> is shown and mutes are scheduled by video
  // time through ClockSync (step 1.3). After a seek it holds playback briefly
  // (like buffering) until the transcript catches up; if it can't within
  // HOLD_MAX_MS, or the page's audio can't be read (live, DRM), the delay line
  // above takes over.
  const LOOKAHEAD_MIN = 3; // seconds of transcript needed ahead to play without delay
  const LOOKAHEAD_GUARD = 1; // hold again if it gets this thin mid-play
  const HOLD_MAX_MS = 4000; // the first Whisper pass after loading can take ~3 s
  const SCHEDULE_AHEAD = 6; // upcoming seconds of words turned into mutes
  let mode = 'delay'; // 'delay' | 'lookahead'
  let fallbackReason = null; // why the delay line is in use, for the label
  let holding = null; // { video } while playback is held for the transcript
  let lastCalibration = 0;
  let lastUpgradeTry = 0;
  const looks = new Map(); // player blob: URL -> { timeline, words, sync, transcriber, scheduled, key }

  // Saved transcripts (step 1.6): rewatching starts with no delay, even
  // before Whisper has loaded.
  const SAVE_EVERY_MS = 15000;
  const transcriptCache = new TranscriptCache();
  transcriptCache.init();

  // The YouTube video ID for the main player's video; null for ads, previews
  // and anything that isn't a watch page or Short. Saved transcripts are in
  // true time (each engine's bias removed), so any engine can reuse them.
  function videoKey(video) {
    if (!video || !video.matches('#movie_player video, .html5-main-video, #shorts-player video, ytd-reel-video-renderer video')) return null;
    if (video.closest('.ad-showing')) return null;
    const m = location.pathname.match(/^\/shorts\/([\w-]{6,})/);
    const id = m ? m[1] : new URLSearchParams(location.search).get('v');
    return id ? `${id}:t` : null;
  }

  function saveTranscript(look) {
    if (!look.key || look.words.version === look.savedVersion) return;
    look.savedVersion = look.words.version;
    transcriptCache.save(look.key, look.words).catch(() => {});
  }

  function saveAllTranscripts() {
    for (const look of looks.values()) saveTranscript(look);
  }
  window.addEventListener('pagehide', saveAllTranscripts);
  document.addEventListener('visibilitychange', () => document.hidden && saveAllTranscripts());
  const transcribeJobs = new Map();
  let nextTranscribeId = 1;

  function activeVideo() {
    let fallback = null;
    for (const d of delayers) {
      if (!d.video.paused && !d.video.ended) return d.video;
      if (d.video.matches('#movie_player video, .html5-main-video')) fallback = d.video;
    }
    return fallback;
  }

  function videoForSrc(src) {
    for (const d of delayers) if (d.video.src === src) return d.video;
    return null;
  }

  function delayerFor(video) {
    for (const d of delayers) if (d.video === video) return d;
    return null;
  }

  function lookFor(video) {
    return video && video.src ? looks.get(video.src) || null : null;
  }

  // Seconds of transcript ahead of the playhead (everything, if it reaches the end).
  function transcriptAhead(look, video) {
    const ahead = look.words.aheadOf(video.currentTime);
    const left = (Number.isFinite(video.duration) ? video.duration : Infinity) - video.currentTime;
    return ahead >= left - 0.1 ? Infinity : ahead;
  }

  function float32ToPcm16Base64(x) {
    const bytes = new Uint8Array(x.length * 2);
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
      bytes[2 * i] = v & 0xff;
      bytes[2 * i + 1] = (v >> 8) & 0xff;
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Lookahead can run on the companion app even while the in-browser model
  // is still loading.
  const PAUSE_CUTS = false; // roadmap step 5.1, see createLook()

  // ───── stem clips for the mixer (roadmap step 4.4) ─────
  // For each upcoming swear, the companion's separated background (music and
  // effects without the voice) for that stretch, fetched a few seconds ahead
  // and kept as an AudioBuffer whose first sample is at media time `start`.
  // The mixer (step 12) plays it in place of the muted mix.
  const CLIP_MARGIN = 0.05; // extra on each side, for crossfades
  let nextClipId = 1;
  const clipRequests = new Map(); // id -> { look, key }
  const clipStats = { requested: 0, ready: 0, failed: 0, leadMs: [], checks: [] };

  function requestStemClip(look, key, from, to) {
    if (!fullAudioOn || !port || look.clips?.has(key)) return;
    look.clips = look.clips || new Map();
    const id = nextClipId++;
    look.clips.set(key, { from, to, requestedAt: performance.now(), buffer: null });
    clipRequests.set(id, { look, key });
    clipStats.requested++;
    port.postMessage({ type: 'stemClip', id, stream: look.src, from, to, vocals: SILENT_TEST });
  }

  function base64ToInt16(b64) {
    const bin = atob(b64);
    const out = new Int16Array(bin.length >> 1);
    for (let i = 0; i < out.length; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      out[i] = v & 0x8000 ? v - 0x10000 : v;
    }
    return out;
  }

  function toAudioBuffer(pcm, channels, rate) {
    const n = Math.floor(pcm.length / channels);
    const buf = ctx.createBuffer(channels, n, rate);
    for (let c = 0; c < channels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) ch[i] = pcm[i * channels + c] / 32767;
    }
    return buf;
  }

  function onStemClip(msg) {
    const req = clipRequests.get(msg.id);
    clipRequests.delete(msg.id);
    const clip = req && req.look.clips?.get(req.key);
    if (!clip || !ctx) return;
    if (msg.error || !msg.background) {
      clip.error = msg.error || 'empty';
      clipStats.failed++;
      return;
    }
    clip.start = msg.start;
    clip.buffer = toAudioBuffer(base64ToInt16(msg.background), msg.channels, msg.rate);
    clipStats.ready++;
    const v = videoForSrc(req.look.src);
    if (v) clipStats.leadMs.push(Math.round((clip.from - v.currentTime) * 1000));
    if (clipStats.leadMs.length > 50) clipStats.leadMs.shift();
    if (SILENT_TEST && msg.vocals) checkClipAlignment(req.look, msg);
  }

  // Test diagnostics: voice + background, brought to 16 kHz, should line up
  // with the decoded audio the transcript was made from at the same media
  // time (best match at 0 ms).
  function checkClipAlignment(look, msg) {
    const bg = base64ToInt16(msg.background);
    const voc = base64ToInt16(msg.vocals);
    const ch = msg.channels;
    const n48 = Math.floor(bg.length / ch);
    const n16 = Math.floor(n48 / 3);
    const mix = new Float32Array(n16);
    for (let i = 0; i < n16; i++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) for (let c = 0; c < ch; c++) acc += bg[(3 * i + k) * ch + c] + voc[(3 * i + k) * ch + c];
      mix[i] = acc / (3 * ch * 32767);
    }
    const W = 16; // ±1 ms
    const ref = look.timeline.read(msg.start - W / 16000, msg.start + (n16 + W) / 16000);
    if (!ref || ref.covered < 0.99) return;
    let best = { lag: 0, c: -2 };
    for (let lag = -W; lag <= W; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i < n16; i++) {
        const x = mix[i], y = ref.samples[i + W + lag] || 0;
        xy += x * y; xx += x * x; yy += y * y;
      }
      const c = xy / Math.sqrt(xx * yy + 1e-12);
      if (c > best.c) best = { lag, c };
    }
    const level = Math.sqrt(mix.reduce((s, x) => s + x * x, 0) / (n16 || 1));
    clipStats.checks.push({ at: +msg.start.toFixed(3), lagMs: +(best.lag / 16).toFixed(3), corr: +best.c.toFixed(4), level: +level.toFixed(4) });
    if (clipStats.checks.length > 30) clipStats.checks.shift();
  }

  // Seconds of voice/background stems the companion has ready past `t`.
  function stemsAhead(look, t) {
    for (const [a, b] of look.stems || []) if (a <= t + 0.05 && t <= b) return +(b - t).toFixed(2);
    return 0;
  }

  function transcribeReady() {
    return engineState() === 'ready';
  }

  // The speech engine as far as filtering is concerned: ready if either the
  // companion app or the built-in model can answer (the built-in model isn't
  // loaded at all while the companion runs).
  function engineState() {
    if (port && state.companion?.state === 'ready') return 'ready';
    return state.engine;
  }

  // `stream` (the player's blob URL) lets the companion transcribe its
  // separated voice stem for that stretch instead (roadmap step 4.3).
  function requestTranscribe(samples, offset, stream) {
    return new Promise((resolve, reject) => {
      if (!transcribeReady()) return reject(new Error('engine not ready'));
      const id = nextTranscribeId++;
      transcribeJobs.set(id, { resolve, reject });
      port.postMessage({ type: 'transcribe', id, offset, stream, pcm16: float32ToPcm16Base64(samples) });
    });
  }

  function createLook(src) {
    const timeline = new PcmTimeline({ keepBehind: 30, keepAhead: 600 });
    const words = new WordTimeline();
    const sync = new ClockSync({ timeline });
    const look = { src, timeline, words, sync, scheduled: new Set(), key: null, savedVersion: 0, lastSave: 0, cacheLoaded: false };
    look.transcriber = new LookaheadTranscriber({
      timeline,
      words,
      transcribe: (samples, offset) => requestTranscribe(samples, offset, src),
      // Where the companion's voice detector heard speech (step 5.1), for
      // stretches it has separated; null elsewhere. Off: cutting windows at
      // pauses measured slightly worse than fixed 10 s windows with 1 s of
      // overlap (7.9% vs 6.1% word errors on the 10 test mixes).
      speech: !PAUSE_CUTS ? null : (t0, t1) => {
        if (!look.stems || !look.stems.some(([a, b]) => a <= t0 + 0.05 && t1 <= b + 0.05)) return null;
        return (look.speech || []).filter(([a, b]) => b > t0 && a < t1);
      },
      playhead: () => videoForSrc(src)?.currentTime ?? null,
      duration: () => {
        const v = videoForSrc(src);
        return v && Number.isFinite(v.duration) ? v.duration : Infinity;
      },
    });
    looks.set(src, look);
    for (const [k, l] of looks) {
      if (k !== src && !videoForSrc(k)) {
        l.transcriber.stop();
        saveTranscript(l);
        looks.delete(k);
      }
    }
    return look;
  }

  // Full-quality lookahead audio for the companion's voice separation
  // (roadmap step 4.2). The page bridge only sends it while asked to, since
  // nothing else needs it.
  let fullAudioOn = false;
  function updateFullAudio() {
    const want = !!(settings.enabled && settings.lookahead && port && state.companion?.state === 'ready' && state.companion.stems);
    if (want === fullAudioOn) return;
    fullAudioOn = want;
    window.postMessage({ __cleanEars: 1, type: 'fullAudio', on: want }, '*');
  }

  function int16ToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.__cleanEars !== 1 || m.type !== 'pcm48') return;
    if (!fullAudioOn || !port || !(m.pcm instanceof Int16Array)) return;
    if (videoForSrc(m.src)?.mediaKeys) return;
    port.postMessage({ type: 'stemAudio', stream: m.src, time: m.time, rate: m.rate, channels: m.channels, pcm16: int16ToBase64(m.pcm) });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.__cleanEars !== 1 || m.type !== 'pcm') return;
    if (!settings.enabled || !settings.lookahead || !(m.samples instanceof Float32Array)) return;
    if (videoForSrc(m.src)?.mediaKeys) return; // encrypted: decoded audio is meaningless
    const look = looks.get(m.src) || createLook(m.src);
    look.timeline.add({ time: m.time, samples: m.samples });
  });

  function clearLookaheadMutes() {
    for (const look of looks.values()) look.scheduled.clear();
    if (mode === 'lookahead' && ctx) {
      intervals = [];
      reschedule();
    }
  }

  const modeLog = []; // test diagnostics: when each mode began, by video time
  function noteMode(m, video) {
    modeLog.push({ mode: m, at: video ? +video.currentTime.toFixed(2) : null, wall: Math.round(performance.now()) });
    if (modeLog.length > 50) modeLog.shift();
  }

  function enterLookahead(video) {
    if (mode !== 'lookahead') noteMode('lookahead', video || activeVideo());
    mode = 'lookahead';
    fallbackReason = null;
    setDelay(0);
    if (video) muteIfResumingInsideSwear(video);
    if (ctx) {
      const g = flushGain.gain; // nothing stale to hide with no delay
      g.cancelScheduledValues(ctx.currentTime);
      g.setTargetAtTime(1, ctx.currentTime, 0.005);
      flushUntil = 0;
    }
    for (const x of delayers) x.setActive(false); // show the real video
    updateBadges();
  }

  function enterDelayMode() {
    const wasLookahead = mode === 'lookahead';
    if (wasLookahead) noteMode('delay', activeVideo());
    mode = 'delay';
    setDelay(targetDelay());
    for (const x of delayers) x.setActive(settings.enabled);
    if (wasLookahead) {
      intervals = [];
      reschedule();
    }
    flush();
    updateBadges();
  }

  function internalPause(video) {
    video.__ceInternalUntil = performance.now() + 400;
    video.pause();
  }

  function internalPlay(video) {
    video.__ceInternalUntil = performance.now() + 400;
    video.play().catch(() => {});
  }

  // Why read-ahead can't be used for this video (null if it can).
  //   live stream: YouTube only has a few seconds downloaded past the live
  //     edge, so there's nothing to read ahead; the delay line does the job.
  //   protected video: DRM (EME) media is encrypted in the page, so the
  //     bridge would only decode noise.
  function lookaheadBlocked(video) {
    if (!settings.lookahead) return 'read-ahead off';
    if (video.mediaKeys) return 'protected video';
    if (isLive(video)) return 'live stream';
    return null;
  }

  function isLive(video) {
    if (video.duration === Infinity) return true;
    const player = video.closest('.html5-video-player');
    // The "Live" badge shows for the whole stream, including when watching
    // behind the live edge (it's only marked disabled then).
    return !!(player && (player.classList.contains('ytp-live') || player.querySelector('.ytp-live-badge')?.offsetParent));
  }

  // Decide how to play from here (on play and after seeks).
  function chooseMode(video, d) {
    fallbackReason = lookaheadBlocked(video);
    if (fallbackReason) {
      if (mode === 'lookahead') enterDelayMode();
      else {
        setDelay(targetDelay());
        flush();
      }
      updateBadges();
      return;
    }
    const look = lookFor(video);
    const engineReady = transcribeReady();
    const cached = transcriptCache.has(videoKey(video));
    // With a saved transcript there's no need to wait for Whisper; the hold
    // below just gives the page bridge a moment to start and the cache to load.
    const available = settings.lookahead && (cached || (look && engineReady));
    if (!available) {
      if (mode === 'lookahead') enterDelayMode();
      else {
        setDelay(targetDelay());
        flush();
      }
      return;
    }
    if (look && transcriptAhead(look, video) >= LOOKAHEAD_MIN) enterLookahead(video);
    else holdForTranscript(video);
  }

  // Playback resuming (after a hold or seek) part-way through a swear's cover
  // would let the rest of it through before the next scheduling tick: mute now.
  function muteIfResumingInsideSwear(video) {
    const look = lookFor(video);
    if (!look || !ctx) return;
    const t = video.currentTime;
    const lag = NO_LAG; // lookahead words are already corrected
    const pad = settings.cover;
    for (const m of PFFilter.findMatches(look.words.between(t - 3, t + 1), compiled)) {
      const m0 = m.start - lag.start - pad;
      const m1 = m.end - lag.end + pad;
      if (m0 <= t && t < m1) {
        look.scheduled.add(Math.round(m.start * 100) + ':' + m.text);
        addInterval(ctx.currentTime, ctx.currentTime + (m1 - t) / (video.playbackRate || 1) + 0.05, m);
      }
    }
  }

  // Pause (like buffering) until the transcript is LOOKAHEAD_MIN ahead.
  function holdForTranscript(video) {
    if (holding) return;
    const started = performance.now();
    holding = { video };
    internalPause(video);
    updateBadges();
    const check = () => {
      if (!holding || holding.video !== video) return; // cancelled (user paused / navigated)
      const look = lookFor(video);
      const ok = look && transcriptAhead(look, video) >= LOOKAHEAD_MIN;
      if (ok || performance.now() - started > HOLD_MAX_MS) {
        holding = null;
        if (ok) enterLookahead(video);
        else enterDelayMode();
        internalPlay(video);
        updateBadges();
      } else setTimeout(check, 100);
    };
    check();
  }

  // Turn upcoming swears in the transcript into mutes, timed by ClockSync.
  function scheduleLookaheadMutes(video, look) {
    const t = video.currentTime;
    const lag = NO_LAG; // lookahead words are already corrected
    const pad = settings.cover;
    for (const m of PFFilter.findMatches(look.words.between(t - 2, t + SCHEDULE_AHEAD), compiled)) {
      const key = Math.round(m.start * 100) + ':' + m.text;
      if (look.scheduled.has(key)) continue;
      const m0 = m.start - lag.start - pad;
      const m1 = m.end - lag.end + pad;
      if (m1 < t) continue;
      const c0 = look.sync.heardAt(m0);
      const c1 = look.sync.heardAt(m1);
      if (c0 == null || c1 == null) continue; // no clock fit yet
      look.scheduled.add(key);
      if (SILENT_TEST) testLog.mutes.push({ text: m.text, wordStart: +m.start.toFixed(2), wordEnd: +m.end.toFixed(2), coverFrom: +m0.toFixed(2), coverTo: +m1.toFixed(2), playhead: +t.toFixed(2), leadSeconds: +(m0 - t).toFixed(2) });
      addInterval(c0 + currentDelay, c1 + currentDelay, m);
      requestStemClip(look, key, m0 - CLIP_MARGIN, m1 + CLIP_MARGIN);
      updateBadges(); // refresh the "N filtered" count
    }
  }

  setInterval(() => {
    if (!ctx || !settings.enabled) return;
    const v = activeVideo();
    for (const look of looks.values()) {
      const mine = v && look.src === v.src && settings.lookahead && transcribeReady();
      if (mine) look.transcriber.start();
      else look.transcriber.stop();
      const lv = videoForSrc(look.src);
      if (lv) look.timeline.evict(lv.currentTime);
    }
    // Keep the label's "why there's a delay" current (live is sometimes only
    // known once the player has set itself up).
    if (v && mode === 'delay') {
      const why = lookaheadBlocked(v);
      if (why !== fallbackReason) {
        fallbackReason = why;
        updateBadges();
      }
    }
    const look = lookFor(v);
    if (!v || !look) return;
    if (!look.key) {
      look.key = videoKey(v);
      if (look.key && transcriptCache.has(look.key)) {
        transcriptCache.load(look.key, look.words).then((ok) => {
          look.cacheLoaded = ok;
          look.savedVersion = look.words.version; // nothing new to save yet
          updateBadges();
        });
      }
    }
    if (look.key && performance.now() - look.lastSave > SAVE_EVERY_MS) {
      look.lastSave = performance.now();
      saveTranscript(look);
    }
    look.sync.notePlayhead(ctx.currentTime, v.currentTime, { paused: v.paused || v.seeking, rate: v.playbackRate });
    if (fullAudioOn && port && performance.now() - (look.lastStemPlayhead || 0) > 2000) {
      look.lastStemPlayhead = performance.now();
      port.postMessage({ type: 'stemPlayhead', stream: look.src, time: v.currentTime });
    }
    if (v.paused || holding) return;

    if (mode === 'lookahead' && lookaheadBlocked(v)) {
      fallbackReason = lookaheadBlocked(v);
      enterDelayMode();
      return;
    }
    if (mode === 'lookahead') {
      if (transcriptAhead(look, v) < LOOKAHEAD_GUARD) {
        holdForTranscript(v);
        return;
      }
      scheduleLookaheadMutes(v, look);
      if (look.clips) for (const [k, c] of look.clips) if (c.to < v.currentTime - 5) look.clips.delete(k); // played
      if (ctx.currentTime - lastCalibration > 2) {
        lastCalibration = ctx.currentTime;
        look.sync.calibrate(ctx.currentTime);
      }
    } else if (!lookaheadBlocked(v) && transcribeReady() && performance.now() - lastUpgradeTry > 5000) {
      // Started in delay mode (e.g. the model was still loading): switch once,
      // by seeking the real playhead back to the picture on screen so nothing
      // is skipped; the seek then holds until the transcript is ready.
      lastUpgradeTry = performance.now();
      const d = delayerFor(v);
      if (d && d.seekTo && look.timeline.readyAhead(v.currentTime) > 5) d.seekTo(d.onScreenTime());
    }
  }, 100);

  // Diagnostics for automated tests (#cleanears-silent-test only).
  const testLog = { mutes: [] };
  if (SILENT_TEST) {
    setInterval(() => {
      const v = activeVideo();
      const look = lookFor(v);
      document.documentElement.dataset.cleanEars = JSON.stringify({
        silent: ctx ? ctx.sinkId && ctx.sinkId.type : 'no audio context yet',
        engine: state.engine,
        device: state.device,
        mode,
        fallbackReason,
        badge: lastBadgeText,
        connLog,
        companion: state.companion || null,
        lastEngine: state.lastEngine || null,
        fullAudio: fullAudioOn,
        asrSource: state.asrSource,
        alignedWords: state.alignedWords || 0,
        clips: clipStats,
        stems: look ? look.stems || [] : [],
        stemsAhead: look && v ? stemsAhead(look, v.currentTime) : null,
        heard: state.lastText || '', // last delay-mode transcript text
        passMs: state.processingMs ? Math.round(state.processingMs) : null,
        live: v ? isLive(v) : null,
        protected: v ? !!v.mediaKeys : null,
        rate: v ? v.playbackRate : null,
        hidden: document.hidden,
        holding: !!holding,
        delay: currentDelay,
        playhead: v ? +v.currentTime.toFixed(2) : null,
        paused: v ? v.paused : null,
        transcriptAhead: v && look ? +Math.min(999, transcriptAhead(look, v)).toFixed(2) : null,
        decodedAhead: v && look ? +look.timeline.readyAhead(v.currentTime, 120).toFixed(2) : null,
        windows: look ? look.transcriber.stats.windows : 0,
        whisperMs: Math.round(state.processingMs || 0),
        calibration: look ? look.sync.lastCalibration : null,
        caught: state.caught,
        missed: state.missed,
        recent: state.recent.slice(0, 10),
        mutes: testLog.mutes.slice(-40),
        words: look ? look.words.words.length : 0,
        cacheKey: look ? look.key : videoKey(v),
        cachedOnDisk: transcriptCache.has(look ? look.key : videoKey(v)),
        cacheLoaded: look ? look.cacheLoaded : false,
        modeLog: modeLog.slice(-12),
        lastWords: look && v ? look.words.between(v.currentTime, v.currentTime + 8).map((w) => w.text).join('') : '',
      });
    }, 500);
  }

  // ───────────────────────── status badge ─────────────────────────

  const badges = new WeakMap();

  function badgeText() {
    if (!settings.enabled) return null;
    if (ctx && ctx.state === 'suspended') return { text: 'Clean Ears: click anywhere to turn the sound on', warn: true };
    // Reading ahead keeps working from the transcript already made while an
    // engine loads or reconnects.
    if (mode === 'lookahead' && !holding && engineState() !== 'error') {
      return { text: `Clean Ears on · no delay${engineNote()} · ${state.caught} filtered` };
    }
    switch (engineState()) {
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
    if (holding) return { text: 'Clean Ears: reading ahead…' };
    if (mode === 'lookahead') return { text: `Clean Ears on · no delay${engineNote()} · ${state.caught} filtered` };
    const why = fallbackReason ? ` (${fallbackReason})` : '';
    if (ctx && ctx.currentTime < flushUntil && anyPlaying()) {
      return { text: `Clean Ears: checking ahead (${currentDelay.toFixed(1)} s)…` };
    }
    if (state.headroom != null && state.headroom < 0.25) {
      return { text: 'Clean Ears is falling behind – raise the delay or pick a smaller model', warn: true };
    }
    return { text: `Clean Ears on · ${currentDelay.toFixed(1)} s delay${why} · ${state.caught} filtered` };
  }

  // Which speech engine is reading ahead, for the label.
  function engineNote() {
    return state.companion?.state === 'ready' ? ' · companion app' : '';
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
      mode,
      fallbackReason,
      companion: state.companion || null,
      measuredNeed: measuredNeed(),
      wordsMeasured: needs.length,
    });
  });
})();

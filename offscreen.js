// Bridges content-script ports (one per YouTube tab) to the Whisper worker.
const worker = new Worker('whisper-worker.js', { type: 'module' });
const ports = new Map(); // session id -> port
let nextSession = 1;
let lastStatus = null;

// Lookahead transcription requests (roadmap step 1.5): worker job id -> the
// tab's port and the id the tab used.
const jobs = new Map();
let nextJob = 1;

// Audio for lookahead requests arrives as base64 16-bit PCM to keep port
// messages small.
function pcm16ToFloat32(b64) {
  const bin = atob(b64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

let browserModel = null; // model the in-browser worker was configured with

worker.onmessage = ({ data }) => {
  if (data.type === 'transcribed') {
    const job = jobs.get(data.id);
    jobs.delete(data.id);
    const port = job && ports.get(job.session);
    if (port) safePost(port, { ...data, id: job.id, engine: 'browser', model: browserModel });
    return;
  }
  if (data.type === 'status') {
    lastStatus = data;
    for (const port of ports.values()) safePost(port, data);
    return;
  }
  const port = ports.get(data.session);
  if (port) safePost(port, data);
};

worker.onerror = (e) => {
  const msg = { type: 'status', state: 'error', message: 'Worker crashed: ' + (e.message || 'unknown error') };
  lastStatus = msg;
  for (const port of ports.values()) safePost(port, msg);
};

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Port already closed; onDisconnect cleans up.
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pf-audio') return;
  const session = nextSession++;
  ports.set(session, port);
  if (lastStatus) safePost(port, lastStatus);

  port.onMessage.addListener((msg) => {
    if (msg.type === 'audio') {
      const samples = new Float32Array(msg.samples);
      if (companion.ready) streamToCompanion(session, samples);
      else {
        ensureWorker(session);
        worker.postMessage({ type: 'audio', session, samples }, [samples.buffer]);
      }
    } else if (msg.type === 'transcribe') {
      const job = nextJob++;
      jobs.set(job, { session, id: msg.id, msg });
      if (companion.ready) companion.send(job, msg);
      else toWorker(job, msg);
    } else if (msg.type === 'config') {
      // The built-in model only loads when it's needed: not while the
      // companion app is answering (roadmap step 2.3).
      configs.set(session, msg);
      if (configured.has(session)) {
        browserModel = msg.model;
        return worker.postMessage({ ...msg, session });
      }
      if (companion.ready) return;
      if (companion.answered) ensureWorker(session);
      else setTimeout(() => companion.ready || ensureWorker(session), 1500); // give it a moment to connect
    } else {
      if (msg.type === 'reset') resetStream(session);
      worker.postMessage({ ...msg, session });
    }
  });
  safePost(port, companion.status());

  port.onDisconnect.addListener(() => {
    ports.delete(session);
    configs.delete(session);
    configured.delete(session);
    streams.delete(session);
    if (ports.size === 0) companion.stop();
    for (const [job, j] of jobs) if (j.session === session) jobs.delete(job);
    worker.postMessage({ type: 'close', session });
    scheduleIdleCheck();
  });
  clearTimeout(idleTimer);
  companion.start();
});

// Sessions whose built-in model setup is held back while the companion runs.
const configs = new Map(); // session -> last config message
const configured = new Set(); // sessions whose config the worker has seen

function ensureWorker(session) {
  if (configured.has(session) || !configs.has(session) || !ports.has(session)) return;
  configured.add(session);
  const msg = configs.get(session);
  browserModel = msg.model;
  worker.postMessage({ ...msg, session });
}

function toWorker(job, msg) {
  const j = jobs.get(job);
  if (j) ensureWorker(j.session);
  const samples = pcm16ToFloat32(msg.pcm16);
  worker.postMessage({ type: 'transcribe', id: job, samples, offset: msg.offset }, [samples.buffer]);
}

// ───────────── companion app (roadmap step 2.2) ─────────────
// A local program that runs the speech model outside the browser. While it's
// connected, lookahead transcription goes to it; if it isn't running (or quits
// mid-video) requests go to the in-browser worker instead.
const companion = {
  url: 'ws://127.0.0.1:47823',
  ws: null,
  ready: false,
  wanted: false,
  info: {},
  sent: new Set(), // job ids waiting on the companion
  timer: null,

  answered: false, // has the first connection attempt finished?

  status() {
    return { type: 'companion', state: this.ready ? 'ready' : this.ws ? this.info.state || 'connecting' : 'off', model: this.info.model, device: this.info.device };
  },
  broadcast() {
    const s = this.status();
    for (const port of ports.values()) safePost(port, s);
  },
  start() {
    this.wanted = true;
    if (!this.ws && !this.timer) this.connect();
  },
  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) this.ws.close();
  },
  retry() {
    clearTimeout(this.timer);
    this.timer = this.wanted ? setTimeout(() => ((this.timer = null), this.connect()), 3000) : null;
  },
  connect() {
    if (this.ws || !this.wanted) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.answered = true;
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', version: 1 }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'status') {
        this.info = m;
        this.answered = true;
        this.ready = m.state === 'ready';
        if (!this.ready && m.state !== 'loading') for (const session of configs.keys()) ensureWorker(session);
        this.broadcast();
      } else if (m.type === 'transcribed') {
        this.sent.delete(m.id);
        const job = jobs.get(m.id);
        if (!job) return;
        if (job.stream) {
          jobs.delete(m.id);
          return streamReply(job, m);
        }
        if (m.error) return toWorker(m.id, job.msg); // let the built-in model try
        jobs.delete(m.id);
        const port = ports.get(job.session);
        if (port) safePost(port, { ...m, id: job.id });
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.ready = false;
      this.answered = true;
      this.info = {};
      // The built-in model takes over: load it for every tab.
      for (const session of configs.keys()) ensureWorker(session);
      for (const st of streams.values()) st.busy = false;
      // Anything the companion hadn't answered goes to the browser model.
      for (const id of this.sent) {
        const job = jobs.get(id);
        if (job && job.stream) jobs.delete(id);
        else if (job) toWorker(id, job.msg);
      }
      this.sent.clear();
      this.broadcast();
      this.retry();
    };
  },
  send(job, msg) {
    this.sent.add(job);
    try {
      this.ws.send(JSON.stringify({ type: 'transcribe', id: job, offset: msg.offset, pcm16: msg.pcm16 }));
    } catch {
      this.sent.delete(job);
      toWorker(job, msg);
    }
  },
};

// With no tab using the engine for a minute, ask the background worker to
// close this document, which unloads the model and frees its memory.
const IDLE_CLOSE_MS = 60 * 1000;
let idleTimer = null;

function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (ports.size === 0) chrome.runtime.sendMessage({ type: 'pf:offscreenIdle' });
  }, IDLE_CLOSE_MS);
}

scheduleIdleCheck();

// ───── delay-line streaming through the companion (roadmap step 2.3) ─────
// In delay mode (live streams, or before the read-ahead is ready) tabs stream
// audio continuously. While the companion runs it transcribes the latest few
// seconds each time enough new audio has arrived, like the built-in worker,
// and replies with the same 'words' messages.
const STREAM_SR = 16000;
const STREAM_MAX_S = 20;
const STREAM_MIN_NEW_S = 0.25;
const STREAM_SILENCE_RMS = 0.003;
const streams = new Map(); // session -> { buf, len, startIndex, processedUntil, busy }

function getStream(session) {
  let st = streams.get(session);
  if (!st) {
    st = { buf: new Float32Array(2 * STREAM_MAX_S * STREAM_SR), len: 0, startIndex: 0, processedUntil: 0, busy: false };
    streams.set(session, st);
  }
  return st;
}

function resetStream(session) {
  const st = streams.get(session);
  if (!st) return;
  st.startIndex += st.len;
  st.len = 0;
  st.processedUntil = st.startIndex;
}

function streamToCompanion(session, samples) {
  const st = getStream(session);
  const keep = STREAM_MAX_S * STREAM_SR;
  if (samples.length > keep) samples = samples.subarray(samples.length - keep);
  // The buffer holds twice what's kept, so the old audio is dropped in one
  // copy every ~20 s rather than on every small chunk.
  if (st.len + samples.length > st.buf.length) {
    const drop = st.len - (keep - samples.length);
    st.buf.copyWithin(0, drop, st.len);
    st.len -= drop;
    st.startIndex += drop;
  }
  st.buf.set(samples, st.len);
  st.len += samples.length;
  pumpStream(session);
}

function pumpStream(session) {
  const st = streams.get(session);
  if (!st || st.busy || !companion.ready) return;
  const end = st.startIndex + st.len;
  if (end - st.processedUntil < STREAM_MIN_NEW_S * STREAM_SR) return;
  const windowS = configs.get(session)?.windowS || 4;
  const winStart = Math.max(st.startIndex, end - windowS * STREAM_SR);
  const audio = st.buf.slice(winStart - st.startIndex, st.len);
  st.processedUntil = end;
  const port = ports.get(session);
  if (!port || audio.length < 0.3 * STREAM_SR) return;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  if (Math.sqrt(sum / audio.length) < STREAM_SILENCE_RMS) {
    safePost(port, { type: 'words', session, words: [], windowEnd: end / STREAM_SR, processingMs: 0, engine: 'companion', model: companion.info.model });
    return;
  }
  st.busy = true;
  const job = nextJob++;
  jobs.set(job, { session, stream: true, windowEnd: end / STREAM_SR, t0: performance.now() });
  companion.sent.add(job);
  try {
    companion.ws.send(JSON.stringify({ type: 'transcribe', id: job, offset: winStart / STREAM_SR, pcm16: float32ToPcm16Base64(audio) }));
  } catch {
    companion.sent.delete(job);
    jobs.delete(job);
    st.busy = false;
  }
}

function streamReply(job, m) {
  const st = streams.get(job.session);
  if (st) st.busy = false;
  const port = ports.get(job.session);
  if (port && !m.error) {
    safePost(port, {
      type: 'words',
      session: job.session,
      words: m.words || [],
      windowEnd: job.windowEnd,
      processingMs: performance.now() - job.t0,
      text: m.text,
      engine: 'companion',
      model: m.model,
    });
  }
  pumpStream(job.session);
}

function float32ToPcm16Base64(f32) {
  const bytes = new Uint8Array(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i])) * 32767;
    const n = v < 0 ? v + 0x10000 : v;
    bytes[2 * i] = n & 0xff;
    bytes[2 * i + 1] = (n >> 8) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

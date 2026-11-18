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
      worker.postMessage({ type: 'audio', session, samples }, [samples.buffer]);
    } else if (msg.type === 'transcribe') {
      const job = nextJob++;
      jobs.set(job, { session, id: msg.id, msg });
      if (companion.ready) companion.send(job, msg);
      else toWorker(job, msg);
    } else {
      if (msg.type === 'config') browserModel = msg.model;
      worker.postMessage({ ...msg, session });
    }
  });
  safePost(port, companion.status());

  port.onDisconnect.addListener(() => {
    ports.delete(session);
    if (ports.size === 0) companion.stop();
    for (const [job, j] of jobs) if (j.session === session) jobs.delete(job);
    worker.postMessage({ type: 'close', session });
    scheduleIdleCheck();
  });
  clearTimeout(idleTimer);
  companion.start();
});

function toWorker(job, msg) {
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
        this.ready = m.state === 'ready';
        this.broadcast();
      } else if (m.type === 'transcribed') {
        this.sent.delete(m.id);
        const job = jobs.get(m.id);
        if (!job) return;
        if (m.error) return toWorker(m.id, job.msg); // let the browser model try
        jobs.delete(m.id);
        const port = ports.get(job.session);
        if (port) safePost(port, { ...m, id: job.id });
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.ready = false;
      this.info = {};
      // Anything the companion hadn't answered goes to the browser model.
      for (const id of this.sent) {
        const job = jobs.get(id);
        if (job) toWorker(id, job.msg);
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

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

worker.onmessage = ({ data }) => {
  if (data.type === 'transcribed') {
    const job = jobs.get(data.id);
    jobs.delete(data.id);
    const port = job && ports.get(job.session);
    if (port) safePost(port, { ...data, id: job.id });
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
      jobs.set(job, { session, id: msg.id });
      const samples = pcm16ToFloat32(msg.pcm16);
      worker.postMessage({ type: 'transcribe', id: job, samples, offset: msg.offset }, [samples.buffer]);
    } else {
      worker.postMessage({ ...msg, session });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(session);
    for (const [job, j] of jobs) if (j.session === session) jobs.delete(job);
    worker.postMessage({ type: 'close', session });
    scheduleIdleCheck();
  });
  clearTimeout(idleTimer);
});

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

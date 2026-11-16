// Bridges content-script ports (one per YouTube tab) to the Whisper worker.
const worker = new Worker('whisper-worker.js', { type: 'module' });
const ports = new Map(); // session id -> port
let nextSession = 1;
let lastStatus = null;

worker.onmessage = ({ data }) => {
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
    } else {
      worker.postMessage({ ...msg, session });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(session);
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

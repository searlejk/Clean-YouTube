// Minimal chrome.* for running content.js outside an extension. The port talks
// to the real Whisper worker the way offscreen.js does (audio, config, reset,
// and base64-PCM 'transcribe' requests).
(() => {
  const worker = new Worker('../../whisper-worker.js', { type: 'module' });
  const listeners = [];
  const jobs = new Map();
  let nextJob = 1;
  const pcm16ToFloat32 = (b64) => {
    const bin = atob(b64);
    const out = new Float32Array(bin.length >> 1);
    for (let i = 0; i < out.length; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  };
  worker.onmessage = ({ data }) => {
    if (data.type === 'transcribed') {
      const j = jobs.get(data.id);
      jobs.delete(data.id);
      if (j) data = { ...data, id: j };
      else return;
    }
    listeners.forEach((l) => l(data));
  };
  const port = {
    postMessage(m) {
      if (m.type === 'audio') {
        const s = new Float32Array(m.samples);
        worker.postMessage({ type: 'audio', session: 1, samples: s }, [s.buffer]);
      } else if (m.type === 'transcribe') {
        const id = nextJob++;
        jobs.set(id, m.id);
        const s = pcm16ToFloat32(m.pcm16);
        worker.postMessage({ type: 'transcribe', id, samples: s, offset: m.offset }, [s.buffer]);
      } else worker.postMessage({ ...m, session: 1 });
    },
    onMessage: { addListener: (f) => listeners.push(f) },
    onDisconnect: { addListener() {} },
    disconnect() {},
  };
  window.__harnessStatus = () => window.__statusListener && new Promise((r) => window.__statusListener({ type: 'pf:getStatus' }, null, r));
  window.chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d }) },
      // Backed by localStorage so a reload of the harness acts as a later visit.
      local: {
        async get(keys) {
          const out = {};
          for (const k of [keys].flat()) {
            const v = localStorage.getItem('harness:' + k);
            if (v !== null) out[k] = JSON.parse(v);
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) localStorage.setItem('harness:' + k, JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of [keys].flat()) localStorage.removeItem('harness:' + k);
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'harness',
      getURL: (p) => '../../' + p,
      sendMessage: async () => ({ ok: true }),
      connect: () => port,
      onMessage: { addListener(f) { window.__statusListener = f; } },
    },
  };
})();

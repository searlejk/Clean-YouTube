// chrome.* for running the content script AND the real offscreen.js in one
// test page (roadmap step 4.4). chrome.runtime.connect returns one end of an
// in-page port pair whose other end goes to offscreen.js's onConnect, with
// messages JSON-copied like real extension ports. offscreen.js then talks to
// a companion on 127.0.0.1:47823 started with --allow-local-test-pages.
// The built-in Whisper worker is replaced by a stub (the companion does the work).
(() => {
  const RealWorker = window.Worker;
  window.Worker = function (url, opts) {
    if (String(url).includes('whisper-worker')) return { postMessage() {}, terminate() {}, onmessage: null, onerror: null };
    return new RealWorker(url, opts);
  };
  const connectListeners = [];
  function pair() {
    const a = { on: [], off: [] };
    const b = { on: [], off: [] };
    const end = (self, other) => ({
      name: 'pf-audio',
      postMessage(m) {
        const copy = JSON.parse(JSON.stringify(m));
        setTimeout(() => other.on.forEach((f) => f(copy)), 0);
      },
      onMessage: { addListener: (f) => self.on.push(f) },
      onDisconnect: { addListener: (f) => self.off.push(f) },
      disconnect() {
        setTimeout(() => other.off.forEach((f) => f()), 0);
      },
    });
    return [end(a, b), end(b, a)];
  }
  const local = {
    async get(keys) {
      const out = {};
      const list = keys && typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : [keys].flat();
      for (const k of list) {
        const v = localStorage.getItem('harness:' + k);
        if (v !== null) out[k] = JSON.parse(v);
        else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) localStorage.setItem('harness:' + k, JSON.stringify(v));
    },
    async remove(keys) {
      for (const k of [keys].flat()) localStorage.removeItem('harness:' + k);
    },
  };
  window.chrome = {
    // ?mode=replace (etc.) overrides a setting for testing.
    storage: { sync: { get: async (d) => ({ ...d, ...Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => k in d)) }) }, local, onChanged: { addListener() {} } },
    runtime: {
      id: 'harness',
      getURL: (p) => '../../' + p,
      sendMessage: async () => ({ ok: true }),
      connect() {
        const [mine, theirs] = pair();
        setTimeout(() => connectListeners.forEach((f) => f(theirs)), 0);
        return mine;
      },
      onConnect: { addListener: (f) => connectListeners.push(f) },
      onMessage: { addListener(f) { window.__statusListener = f; } },
    },
  };
})();
